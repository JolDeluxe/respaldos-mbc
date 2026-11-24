import { runBackup } from '../backup/runner.js';
import { checkMysqldump, checkSqlite3, clientOlderThanServer } from '../backup/tools.js';
import { assertNodeVersion, loadAppConfig, loadDotenv, REQUIRED_NODE, type AppConfig } from '../config/load.js';
import { createContext, type AppContext } from '../context.js';
import { createLogger } from '../logging/logger.js';
import { GB } from '../storage/disk.js';
import { inspectLock } from '../storage/lock.js';
import { errMessage, BackupError } from '../util/errors.js';
import { parseDailyCron } from '../util/time.js';
import { verifyBackups } from '../validation/verify.js';

const HELP = `mbc-backup-service CLI

Uso: node dist/cli/index.js <comando> [opciones]

  validate-config         Valida .env y config/databases.json (sin conectarse a ninguna base)
  tools                   Comprueba mysqldump y sqlite3 (solo ejecuta --version)
  dry-run                 Simula una ejecución: detecta bases y muestra qué se respaldaría (no escribe respaldos)
  run --confirm           Ejecuta un respaldo MANUAL real de todas las bases (requiere --confirm)
  verify [--deep] [--latest] [--db <id>]
                          Verifica respaldos existentes (gzip, SHA-256, manifiesto)
  status | health-check   Estado del servicio, última ejecución, bloqueo y espacio (sin conectarse a bases)
`;

function loadCtx(consoleLog = true): { cfg: AppConfig; ctx: AppContext } {
  const baseDir = process.cwd();
  assertNodeVersion();
  loadDotenv(baseDir);
  const cfg = loadAppConfig(process.env, baseDir);
  const log = createLogger({
    level: cfg.env.LOG_LEVEL,
    logDir: cfg.paths.logDir,
    maxMb: cfg.env.LOG_MAX_MB,
    maxFiles: cfg.env.LOG_MAX_FILES,
    console: false,
  });
  void consoleLog;
  return { cfg, ctx: createContext(cfg, log) };
}

const out = (s = '') => console.log(s);

async function cmdValidate(): Promise<number> {
  const { cfg } = loadCtx();
  const d = cfg.databases;
  out(`Node.js ${process.versions.node} (requerido ${REQUIRED_NODE}) OK`);
  out(`Modo: ${cfg.env.MBC_MODE} | MBC_ALLOW_LIVE=${cfg.env.MBC_ALLOW_LIVE} | ENABLE_SCHEDULER=${cfg.env.ENABLE_SCHEDULER}`);
  out(`Destino de respaldos: ${cfg.paths.backupRoot}`);
  out(`Programación: "${cfg.env.CRON_EXPRESSION}" (${cfg.env.TIMEZONE}) | retención: ${cfg.env.RETENTION_COUNT} | reserva libre: ${cfg.env.MIN_FREE_GB} GB`);
  if (!parseDailyCron(cfg.env.CRON_EXPRESSION)) out('AVISO: la expresión no es diaria simple; la recuperación automática no aplicará.');
  for (const m of d.mysql) {
    const hasPwd = !!process.env[m.passwordEnv];
    out(`MySQL ${m.id}: ${m.enabled ? 'habilitada' : 'deshabilitada'} ${m.host}:${m.port} usuario=${m.user} autoDiscover=${m.autoDiscover} contraseña(${m.passwordEnv})=${hasPwd ? 'definida' : 'NO definida'}`);
  }
  for (const s of d.sqlite) out(`SQLite ${s.id}: ${s.enabled ? 'habilitada' : 'deshabilitada'} ${s.path}`);
  out('Configuración válida.');
  return 0;
}

async function cmdTools(): Promise<number> {
  const { ctx } = loadCtx();
  const [my, sq] = await Promise.all([checkMysqldump(ctx), checkSqlite3(ctx)]);
  for (const t of [my, sq]) out(`${t.ok ? 'OK   ' : 'FALLA'} ${t.name}: ${t.path} ${t.ok ? `v${t.version}` : `- ${t.error}`}`);
  if (my.ok && my.version && !my.version.startsWith('8.4')) {
    out(`AVISO: mysqldump ${my.version}. Para servidores MySQL 8.4 use el mysqldump 8.4 de la instalación del servidor (MYSQLDUMP_PATH).`);
  }
  return my.ok && sq.ok ? 0 : 1;
}

async function cmdRun(args: string[], dry: boolean): Promise<number> {
  if (!dry && !args.includes('--confirm')) {
    out('Respaldo real NO ejecutado: agregue --confirm para confirmar explícitamente (npm run backup:run -- --confirm).');
    return 2;
  }
  const { ctx } = loadCtx();
  const rec = await runBackup(ctx, { type: 'MANUAL', dryRun: dry });
  out(`${dry ? 'Simulación' : 'Ejecución'} ${rec.runId}: ${rec.status}`);
  if (rec.freeBytesAtStart !== undefined) out(`Espacio libre: ${(rec.freeBytesAtStart / GB).toFixed(2)} GB`);
  for (const m of rec.discovered.mysql) out(`MySQL ${m.instanceId}: ${m.schemas.join(', ') || '(ninguna)'}`);
  if (rec.discovered.sqlite.length) out(`SQLite: ${rec.discovered.sqlite.join(', ')}`);
  for (const r of rec.results) {
    const extra = r.status === 'success' ? `${r.file} (${r.sizeBytes} bytes)` : (r.error ?? r.skippedReason ?? '');
    out(`  [${r.status}] ${r.key} ${extra}`);
  }
  for (const e of rec.errors) out(`  ERROR: ${e}`);
  return rec.status === 'success' || (dry && rec.status === 'partial') ? 0 : 1;
}

async function cmdVerify(args: string[]): Promise<number> {
  const { ctx } = loadCtx();
  const dbIdx = args.indexOf('--db');
  const items = await verifyBackups(ctx, {
    deep: args.includes('--deep'),
    latestOnly: args.includes('--latest'),
    databaseId: dbIdx >= 0 ? args[dbIdx + 1] : undefined,
  });
  for (const i of items) out(`${i.ok ? 'OK   ' : 'FALLA'} ${i.engine}/${i.databaseId} ${i.fileName}${i.ok ? '' : ' - ' + i.problems.join('; ')}`);
  out(`${items.length} respaldo(s) verificados, ${items.filter((i) => !i.ok).length} con problemas.`);
  return items.every((i) => i.ok) ? 0 : 1;
}

async function cmdStatus(): Promise<number> {
  const { cfg, ctx } = loadCtx();
  const state = await ctx.state.read();
  const lock = await inspectLock(cfg.paths.lockFile, cfg.env.LOCK_STALE_MINUTES * 60_000);
  let free = 'n/d';
  try {
    free = `${((await ctx.freeBytes(cfg.paths.backupRoot)) / GB).toFixed(2)} GB`;
  } catch {
    /* ignorar */
  }
  out(`Modo: ${cfg.env.MBC_MODE} | Programador: ${cfg.env.ENABLE_SCHEDULER ? 'habilitado' : 'deshabilitado'} (${cfg.env.CRON_EXPRESSION} ${cfg.env.TIMEZONE})`);
  out(`Primer inicio: ${state.firstSeenAt ?? '-'} | Último inicio: ${state.lastStartAt ?? '-'}`);
  out(`Última ejecución: ${state.lastRun ? `${state.lastRun.runId} ${state.lastRun.type} ${state.lastRun.status} (ok=${state.lastRun.ok} fallos=${state.lastRun.failed} omitidas=${state.lastRun.skipped})` : '-'}`);
  out(`Última completada: ${state.lastCompletedAt ?? '-'} | Última recuperación: ${state.lastRecoveryAt ?? '-'}`);
  out(`Bloqueo: ${lock.present ? (lock.active ? `ACTIVO (PID ${lock.info.pid})` : 'abandonado (se reclamará)') : 'libre'}`);
  out(`Espacio libre en destino: ${free} (reserva ${cfg.env.MIN_FREE_GB} GB)`);
  const runs = await ctx.state.listRuns(5);
  for (const r of runs) out(`  - ${r.runId} ${r.type} ${r.status}${r.dryRun ? ' (dry)' : ''}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'validate-config':
        return await cmdValidate();
      case 'tools':
        return await cmdTools();
      case 'dry-run':
        return await cmdRun(args, true);
      case 'run':
        return await cmdRun(args, false);
      case 'verify':
        return await cmdVerify(args);
      case 'status':
      case 'health-check':
        return await cmdStatus();
      default:
        out(HELP);
        return cmd ? 2 : 0;
    }
  } catch (err) {
    console.error(`${err instanceof BackupError ? `[${err.code}] ` : ''}${errMessage(err)}`);
    return 1;
  }
}
