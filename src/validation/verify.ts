import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipToFile, verifyGzipFile } from '../backup/gzip.js';
import { BACKUP_FILE_RE, MANIFEST_SUFFIX } from '../storage/layout.js';
import { errMessage } from '../util/errors.js';
import type { AppContext } from '../context.js';
import type { Manifest } from '../types.js';

export interface VerifyItem {
  manifestPath: string;
  databaseId: string;
  engine: string;
  fileName: string;
  ok: boolean;
  problems: string[];
  deep?: boolean;
}

export interface VerifyOptions {
  /** SQLite: además descomprime y ejecuta PRAGMA integrity_check (requiere sqlite3.exe). */
  deep?: boolean;
  databaseId?: string;
  /** Solo el respaldo más reciente de cada base. */
  latestOnly?: boolean;
  signal?: AbortSignal;
}

async function findManifests(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await findManifests(full, depth + 1, out);
    else if (e.isFile() && e.name.endsWith(MANIFEST_SUFFIX) && BACKUP_FILE_RE.test(e.name.slice(0, -MANIFEST_SUFFIX.length))) out.push(full);
  }
}

/** Verifica respaldos existentes leyendo solo el disco (no se conecta a ninguna base). */
export async function verifyBackups(ctx: AppContext, opts: VerifyOptions = {}): Promise<VerifyItem[]> {
  const manifests: string[] = [];
  for (const engine of ['mysql', 'sqlite']) await findManifests(path.join(ctx.cfg.paths.backupRoot, engine), 0, manifests);

  const loaded: Array<{ file: string; m: Manifest }> = [];
  for (const file of manifests) {
    try {
      const m = JSON.parse(await fs.readFile(file, 'utf8')) as Manifest;
      if (!opts.databaseId || m.databaseId === opts.databaseId) loaded.push({ file, m });
    } catch {
      loaded.push({ file, m: { databaseId: '?', engine: '?', fileName: path.basename(file) } as unknown as Manifest });
    }
  }
  let selected = loaded;
  if (opts.latestOnly) {
    const best = new Map<string, { file: string; m: Manifest }>();
    for (const l of loaded) {
      const k = `${l.m.engine}:${l.m.instanceId ?? ''}:${l.m.databaseId}`;
      const cur = best.get(k);
      if (!cur || (l.m.finishedAt ?? '') > (cur.m.finishedAt ?? '')) best.set(k, l);
    }
    selected = [...best.values()];
  }

  const items: VerifyItem[] = [];
  for (const { file, m } of selected) {
    const item: VerifyItem = { manifestPath: file, databaseId: m.databaseId, engine: m.engine, fileName: m.fileName, ok: true, problems: [], deep: opts.deep };
    items.push(item);
    if (!m.sha256) {
      item.ok = false;
      item.problems.push('manifiesto ilegible o incompleto');
      continue;
    }
    const gz = path.join(path.dirname(file), m.fileName);
    try {
      const v = await verifyGzipFile(gz, opts.signal);
      if (v.sizeBytes !== m.sizeBytes) item.problems.push('el tamaño no coincide con el manifiesto');
      if (v.sha256 !== m.sha256) item.problems.push('SHA-256 del archivo no coincide con el manifiesto');
      if (v.contentSha256 !== m.contentSha256) item.problems.push('SHA-256 del contenido no coincide con el manifiesto');
      if (m.engine === 'mysql' && !/-- Dump completed/.test(v.tail)) item.problems.push('volcado MySQL incompleto');
      if (opts.deep && m.engine === 'sqlite' && item.problems.length === 0) {
        const tmp = path.join(ctx.cfg.paths.tempDir, `verify-${process.pid}-${Date.now()}.partial-db`);
        await fs.mkdir(ctx.cfg.paths.tempDir, { recursive: true });
        try {
          await gunzipToFile(gz, tmp, opts.signal);
          const r = await ctx.runner.run(ctx.cfg.env.SQLITE3_PATH, [tmp, 'PRAGMA integrity_check;'], { timeoutMs: 600_000 });
          if (r.code !== 0 || r.stdout.trim() !== 'ok') item.problems.push('PRAGMA integrity_check falló sobre la copia restaurada');
        } finally {
          await fs.rm(tmp, { force: true });
        }
      }
    } catch (err) {
      item.problems.push(`no se pudo leer el archivo: ${errMessage(err)}`);
    }
    item.ok = item.problems.length === 0;
    ctx.log.info({ database: m.databaseId, file: m.fileName, ok: item.ok, problems: item.problems }, 'Verificación de respaldo');
  }
  return items;
}
