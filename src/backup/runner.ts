import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dumpMysqlSchema } from './mysql/dump.js';
import { backupSqliteFile, tempCopyName } from './sqlite/backup.js';
import { verifyGzipFile } from './gzip.js';
import { checkMysqldump, checkSqlite3, type ToolStatus } from './tools.js';
import { readDatabasesFile, type AppConfig } from '../config/load.js';
import { discoverTargets } from '../discovery/index.js';
import { cleanOrphans, reconcileInterruptedRun } from '../recovery/recovery.js';
import { applyRetention } from '../retention/retention.js';
import { GB } from '../storage/disk.js';
import { backupFileName, MANIFEST_SUFFIX, monthDir } from '../storage/layout.js';
import { acquireLock } from '../storage/lock.js';
import { BackupError, errMessage, isAbortError } from '../util/errors.js';
import { atomicWriteJson, exists, renameWithRetry } from '../util/fsx.js';
import { formatStamp } from '../util/time.js';
import type { AppContext } from '../context.js';
import type { BackupTarget, DbResult, Manifest, RunRecord, RunStatus, RunType } from '../types.js';

/** En modo "development" ninguna operación real (MySQL/archivos) se ejecuta sin MBC_ALLOW_LIVE=true.
 * En modo dry-run, si estamos en development, se permite la simulación de lectura si MBC_ALLOW_LIVE está activo,
 * pero si MBC_MODE !== 'production' y no es dryRun ni tiene MBC_ALLOW_LIVE, queda estrictamente bloqueado.
 */
export function assertLiveAllowed(cfg: AppConfig, dryRun = false): void {
  if (cfg.env.MBC_MODE !== 'production') {
    if (!cfg.env.MBC_ALLOW_LIVE) {
      throw new BackupError(
        'LIVE_BLOCKED',
        'Operación bloqueada: MBC_MODE=development y MBC_ALLOW_LIVE=false. No se accede a bases ni se escribe en BACKUP_ROOT. ' +
          'Defina MBC_MODE=production (servidor) o MBC_ALLOW_LIVE=true de forma explícita para pruebas controladas.',
      );
    }
  }
}

export interface RunOptions {
  type: RunType;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Cierre ordenado: no iniciar más bases, terminar la actual. */
  shouldStop?: () => boolean;
}

interface ToolInfo {
  mysqldump?: ToolStatus;
  sqlite3?: ToolStatus;
}

function newRunId(ctx: AppContext): string {
  return `${formatStamp(ctx.now(), ctx.cfg.env.TIMEZONE).replace('_', '-')}-${randomBytes(2).toString('hex')}`;
}

function summarize(results: DbResult[]) {
  return {
    ok: results.filter((r) => r.status === 'success').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
}

export async function runBackup(baseCtx: AppContext, opts: RunOptions): Promise<RunRecord> {
  const dry = opts.dryRun ?? false;
  assertLiveAllowed(baseCtx.cfg, dry);
  const { log } = baseCtx;
  const tz = baseCtx.cfg.env.TIMEZONE;

  // 1. Bloqueo exclusivo persistente (no se usa en simulaciones: son de solo lectura)
  const runId = newRunId(baseCtx);
  const lock = dry
    ? undefined
    : await acquireLock(baseCtx.cfg.paths.lockFile, { staleMs: baseCtx.cfg.env.LOCK_STALE_MINUTES * 60_000, runId, now: baseCtx.now });

  const startedAt = baseCtx.now();
  const record: RunRecord = {
    runId,
    type: opts.type,
    dryRun: dry,
    status: 'running',
    startedAt: startedAt.toISOString(),
    node: process.versions.node,
    discovered: { mysql: [], sqlite: [] },
    results: [],
    errors: [],
  };
  let ctx = baseCtx;
  let finalStatus: RunStatus = 'failed';

  try {
    if (!dry) {
      await reconcileInterruptedRun(baseCtx, { lockHeldByUs: true });
      await fs.mkdir(baseCtx.cfg.paths.tempDir, { recursive: true });
      await baseCtx.state.update((s) => {
        s.currentRun = { runId, type: opts.type, startedAt: record.startedAt, pid: process.pid };
      });
      await baseCtx.state.writeRun(record);
      await cleanOrphans(baseCtx);
    }
    log.info({ runId, type: opts.type, dryRun: dry }, 'Inicio de ejecución de respaldo');

    // 2. Validar configuración (se relee databases.json para tomar altas recientes sin reiniciar)
    if (await exists(baseCtx.cfg.paths.configPath)) {
      try {
        const fresh = readDatabasesFile(baseCtx.cfg.paths.configPath);
        ctx = { ...baseCtx, cfg: { ...baseCtx.cfg, databases: fresh } };
      } catch (err) {
        const msg = `Configuración actual inválida; se usa la última configuración válida en memoria: ${errMessage(err)}`;
        record.errors.push(msg);
        log.error(msg);
      }
    }
    const { databases } = ctx.cfg;
    const needMysql = databases.mysql.some((m) => m.enabled);
    const needSqlite = databases.sqlite.some((s) => s.enabled);

    // 3. Herramientas
    const tools: ToolInfo = {};
    if (needMysql) tools.mysqldump = await checkMysqldump(ctx);
    if (needSqlite) tools.sqlite3 = await checkSqlite3(ctx);
    for (const t of [tools.mysqldump, tools.sqlite3]) {
      if (!t) continue;
      if (t.ok) log.info({ tool: t.name, version: t.version }, 'Herramienta disponible');
      else {
        const msg = `Herramienta no disponible (${t.name}): ${t.error}`;
        record.errors.push(msg);
        log.error(msg);
      }
    }

    // 4. Espacio en disco (aborta sin borrar nada)
    const minFree = ctx.cfg.env.MIN_FREE_GB * GB;
    const free = await ctx.freeBytes(ctx.cfg.paths.backupRoot);
    record.freeBytesAtStart = free;
    log.info({ freeBytes: free, minFreeBytes: minFree }, 'Espacio disponible en el destino de respaldos');
    if (free < minFree) {
      const msg = `Espacio insuficiente: ${(free / GB).toFixed(2)} GB libres, reserva mínima ${ctx.cfg.env.MIN_FREE_GB} GB. Ejecución detenida sin eliminar respaldos.`;
      record.errors.push(msg);
      log.error({ freeBytes: free, minFreeBytes: minFree }, msg);
      finalStatus = 'aborted';
      return await finish(ctx, record, finalStatus, dry);
    }

    // 5-6. Descubrimiento MySQL + inventario SQLite
    const disc = await discoverTargets(ctx, { mysql: !!tools.mysqldump?.ok, sqlite: true });
    record.discovered = disc.discovered;
    record.errors.push(...disc.errors);
    const targets = disc.targets;
    if (targets.length === 0 && record.errors.length === 0) record.errors.push('No hay bases de datos para respaldar según la configuración.');

    if (dry) {
      record.results = targets.map((t) => ({
        key: t.key,
        engine: t.engine,
        databaseId: t.databaseId,
        sourceName: t.sourceName,
        status: 'skipped' as const,
        skippedReason: 'simulación (dry-run)',
      }));
      finalStatus = record.errors.length ? 'partial' : 'success';
      return await finish(ctx, record, finalStatus, true);
    }

    // 7-13. Secuencial: una base a la vez
    let stopped = false;
    let diskAbort = false;
    for (const target of targets) {
      if (opts.signal?.aborted || opts.shouldStop?.()) {
        stopped = true;
        record.results.push(skipResult(target, 'cierre ordenado solicitado'));
        continue;
      }
      if (diskAbort) {
        record.results.push(skipResult(target, 'espacio insuficiente'));
        continue;
      }
      const need = minFree + Math.ceil(target.estimatedBytes * 0.5);
      const freeNow = await ctx.freeBytes(ctx.cfg.paths.backupRoot);
      if (freeNow < need) {
        const msg = `Espacio insuficiente para ${target.key}: libre ${(freeNow / GB).toFixed(2)} GB`;
        log.error({ database: target.key, freeBytes: freeNow, neededBytes: need }, msg);
        record.errors.push(msg);
        record.results.push({ ...skipResult(target, msg), status: 'failed', error: msg });
        diskAbort = true;
        continue;
      }
      const res = await backupOne(ctx, record, target, tools, disc.mysqlServerVersions[target.instanceId ?? ''], opts);
      record.results.push(res);
      await ctx.state.writeRun(record).catch(() => undefined);
    }

    const { ok, failed } = summarize(record.results);
    if (opts.signal?.aborted) finalStatus = 'interrupted';
    else if (stopped) finalStatus = 'interrupted';
    else if (diskAbort) finalStatus = 'aborted';
    else if (ok > 0 && failed === 0 && record.errors.length === 0) finalStatus = 'success';
    else if (ok > 0) finalStatus = 'partial';
    else finalStatus = 'failed';
    return await finish(ctx, record, finalStatus, false);
  } catch (err) {
    record.errors.push(errMessage(err));
    log.error({ err: errMessage(err) }, 'Fallo inesperado durante la ejecución');
    finalStatus = opts.signal?.aborted ? 'interrupted' : 'failed';
    return await finish(ctx, record, finalStatus, dry);
  } finally {
    await lock?.release();
  }
}

function skipResult(t: BackupTarget, reason: string): DbResult {
  return { key: t.key, engine: t.engine, databaseId: t.databaseId, sourceName: t.sourceName, status: 'skipped', skippedReason: reason };
}

async function finish(ctx: AppContext, record: RunRecord, status: RunStatus, dry: boolean): Promise<RunRecord> {
  const end = ctx.now();
  record.status = status;
  record.finishedAt = end.toISOString();
  record.durationMs = end.getTime() - new Date(record.startedAt).getTime();
  const sum = summarize(record.results);
  ctx.log.info(
    { runId: record.runId, type: record.type, status, ...sum, durationMs: record.durationMs, errors: record.errors, dryRun: dry },
    'Fin de ejecución de respaldo',
  );
  if (!dry) {
    await ctx.state.writeRun(record).catch((e) => ctx.log.error({ err: errMessage(e) }, 'No se pudo guardar el registro de ejecución'));
    await ctx.state
      .update((s) => {
        s.lastRun = { runId: record.runId, type: record.type, status, startedAt: record.startedAt, finishedAt: record.finishedAt, ...sum };
        if (status === 'success' || status === 'partial') s.lastCompletedAt = record.finishedAt;
        if (record.type === 'RECOVERY') s.lastRecoveryAt = record.finishedAt;
        if (s.currentRun?.runId === record.runId) delete s.currentRun;
      })
      .catch((e) => ctx.log.error({ err: errMessage(e) }, 'No se pudo actualizar el estado'));
    await ctx.state.pruneRuns().catch(() => undefined);
  }
  return record;
}

async function backupOne(
  ctx: AppContext,
  run: RunRecord,
  target: BackupTarget,
  tools: ToolInfo,
  serverVersion: string | undefined,
  opts: RunOptions,
): Promise<DbResult> {
  const { cfg, log } = ctx;
  const tz = cfg.env.TIMEZONE;
  const t0 = ctx.now();
  const result: DbResult = {
    key: target.key,
    engine: target.engine,
    databaseId: target.databaseId,
    sourceName: target.sourceName,
    status: 'failed',
    startedAt: t0.toISOString(),
  };
  let partialPath: string | undefined;
  let tempCopy: string | undefined;
  log.info({ database: target.key }, 'Iniciando respaldo');
  for (const w of target.warnings ?? []) log.warn({ database: target.key }, w);
  try {
    const dir = monthDir(cfg.paths.backupRoot, target, t0, tz);
    await fs.mkdir(dir, { recursive: true });
    const stamp = formatStamp(t0, tz);
    let seq = 1;
    let fileName = backupFileName(stamp, run.type, target, seq);
    while (
      (await exists(path.join(dir, fileName))) ||
      (await exists(path.join(dir, `${fileName}.partial`))) ||
      (await exists(path.join(dir, fileName + MANIFEST_SUFFIX)))
    ) {
      if (++seq > 99) throw new BackupError('VALIDATION_FAILED', 'No se encontró un nombre de archivo libre.');
      fileName = backupFileName(stamp, run.type, target, seq);
    }
    const finalPath = path.join(dir, fileName);
    partialPath = `${finalPath}.partial`;
    const timeoutMs = cfg.env.TOOL_TIMEOUT_MINUTES * 60_000;
    const level = cfg.env.GZIP_LEVEL;
    const checks: string[] = [];
    let stats;
    let tool: { name: string; version: string };

    if (target.engine === 'mysql') {
      const t = tools.mysqldump;
      if (!t?.ok) throw new BackupError('TOOL_MISSING', 'mysqldump no disponible.');
      const inst = target.mysql!;
      const password = ctx.secrets[inst.passwordEnv];
      if (!password) throw new BackupError('CONFIG_INVALID', `Variable ${inst.passwordEnv} no definida.`);
      stats = await dumpMysqlSchema(ctx.runner, {
        command: cfg.env.MYSQLDUMP_PATH,
        instance: inst,
        schema: target.sourceName,
        password,
        tempDir: cfg.paths.tempDir,
        partialPath,
        gzipLevel: level,
        timeoutMs,
        signal: opts.signal,
      });
      checks.push('mysqldump código 0', 'marca "Dump completed" presente');
      tool = { name: 'mysqldump', version: t.version ?? 'desconocida' };
    } else {
      const t = tools.sqlite3;
      if (!t?.ok) throw new BackupError('TOOL_MISSING', 'sqlite3 no disponible.');
      tempCopy = tempCopyName(cfg.paths.tempDir, run.runId, target.databaseId);
      const r = await backupSqliteFile(ctx.runner, {
        command: cfg.env.SQLITE3_PATH,
        sourcePath: target.sqlitePath!,
        tempCopyPath: tempCopy,
        partialPath,
        gzipLevel: level,
        timeoutMs,
        signal: opts.signal,
      });
      stats = r;
      checks.push(...r.checks);
      tool = { name: 'sqlite3', version: t.version ?? 'desconocida' };
    }

    // Validación del archivo comprimido (lectura completa en streaming)
    const ver = await verifyGzipFile(partialPath, opts.signal);
    if (ver.contentSha256 !== stats.contentSha256) {
      throw new BackupError('VALIDATION_FAILED', 'El contenido descomprimido no coincide con el SHA-256 calculado durante la exportación.');
    }
    if (ver.sizeBytes === 0 || ver.contentBytes === 0) throw new BackupError('VALIDATION_FAILED', 'Archivo resultante vacío.');
    checks.push('gzip íntegro (CRC)', 'SHA-256 del contenido coincide tras descomprimir');

    // Publicación atómica: .partial -> definitivo; el manifiesto se escribe al final
    if (await exists(finalPath)) throw new BackupError('VALIDATION_FAILED', 'El archivo definitivo ya existe; no se sobrescribe.');
    await renameWithRetry(partialPath, finalPath);
    partialPath = undefined;
    const t1 = ctx.now();
    const manifest: Manifest = {
      schemaVersion: 1,
      databaseId: target.databaseId,
      engine: target.engine,
      instanceId: target.instanceId,
      sourceName: target.sourceName,
      displayName: target.displayName,
      runId: run.runId,
      runType: run.type,
      startedAt: t0.toISOString(),
      finishedAt: t1.toISOString(),
      durationMs: t1.getTime() - t0.getTime(),
      fileName,
      relativePath: path.relative(cfg.paths.backupRoot, finalPath).split(path.sep).join('/'),
      sizeBytes: ver.sizeBytes,
      sha256: ver.sha256,
      contentSha256: ver.contentSha256,
      contentBytes: ver.contentBytes,
      validation: { result: 'ok', checks },
      tool,
      serverVersion,
      status: 'success',
    };
    await atomicWriteJson(finalPath + MANIFEST_SUFFIX, manifest);

    result.status = 'success';
    result.finishedAt = t1.toISOString();
    result.durationMs = manifest.durationMs;
    result.sizeBytes = ver.sizeBytes;
    result.sha256 = ver.sha256;
    result.file = manifest.relativePath;
    log.info(
      { database: target.key, file: manifest.relativePath, sizeBytes: ver.sizeBytes, contentBytes: ver.contentBytes, sha256: ver.sha256, durationMs: manifest.durationMs },
      'Respaldo validado y publicado',
    );

    // Retención: solo después de publicar y validar el nuevo respaldo, y solo de esta base
    try {
      const ret = await applyRetention(ctx, target);
      result.retention = ret;
    } catch (err) {
      log.error({ database: target.key, err: errMessage(err) }, 'Error aplicando retención (el respaldo nuevo es válido)');
    }
  } catch (err) {
    result.status = 'failed';
    result.error = isAbortError(err) ? 'Cancelado por cierre del servicio' : errMessage(err);
    const end = ctx.now();
    result.finishedAt = end.toISOString();
    result.durationMs = end.getTime() - t0.getTime();
    log.error({ database: target.key, err: result.error }, 'Respaldo fallido; se conservan los respaldos anteriores');
  } finally {
    if (partialPath) await fs.rm(partialPath, { force: true }).catch(() => undefined);
    if (tempCopy) await fs.rm(tempCopy, { force: true }).catch(() => undefined);
  }
  return result;
}
