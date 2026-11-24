import os from 'node:os';
import { loadAppConfig, loadDotenv, assertNodeVersion } from './config/load.js';
import { createContext } from './context.js';
import { createLogger } from './logging/logger.js';
import { reconcileInterruptedRun } from './recovery/recovery.js';
import { BackupScheduler } from './scheduler/scheduler.js';
import { errMessage } from './util/errors.js';

/**
 * Servicio permanente (PM2). Sin puertos HTTP. En desarrollo el programador está desactivado
 * (ENABLE_SCHEDULER=false) y no se contacta ninguna base.
 */
export async function startService(baseDir = process.cwd()): Promise<number> {
  assertNodeVersion();
  loadDotenv(baseDir);
  const cfg = loadAppConfig(process.env, baseDir);
  const log = createLogger({
    level: cfg.env.LOG_LEVEL,
    logDir: cfg.paths.logDir,
    maxMb: cfg.env.LOG_MAX_MB,
    maxFiles: cfg.env.LOG_MAX_FILES,
    console: cfg.env.LOG_TO_CONSOLE,
  });
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* no crítico */
  }
  const ctx = createContext(cfg, log);

  log.info(
    { mode: cfg.env.MBC_MODE, scheduler: cfg.env.ENABLE_SCHEDULER, node: process.versions.node, backupRoot: cfg.paths.backupRoot },
    'mbc-backup-service iniciado',
  );

  if (!cfg.env.ENABLE_SCHEDULER) {
    log.warn('ENABLE_SCHEDULER=false: programador desactivado, no se realizarán respaldos. Saliendo.');
    console.log('Programador desactivado (ENABLE_SCHEDULER=false). Nada que ejecutar.');
    return 0;
  }
  if (cfg.env.MBC_MODE !== 'production' && !cfg.env.MBC_ALLOW_LIVE) {
    log.warn('Modo development sin MBC_ALLOW_LIVE: el programador no se inicia.');
    console.log('Modo development sin MBC_ALLOW_LIVE=true: el programador no se inicia.');
    return 0;
  }

  await ctx.state.update((s) => {
    s.firstSeenAt ??= ctx.now().toISOString();
    s.lastStartAt = ctx.now().toISOString();
  });
  await reconcileInterruptedRun(ctx);

  const scheduler = new BackupScheduler(ctx);
  scheduler.start();
  await scheduler.scheduleRecoveryIfNeeded();

  return new Promise<number>((resolve) => {
    let closing = false;
    const close = (reason: string) => {
      if (closing) return;
      closing = true;
      log.warn({ reason }, 'Apagado ordenado iniciado');
      scheduler
        .shutdown(cfg.env.SHUTDOWN_GRACE_SECONDS * 1000)
        .then((r) => log.info({ result: r }, 'Apagado ordenado completado'))
        .catch((err) => log.error({ err: errMessage(err) }, 'Error durante el apagado'))
        .finally(() => resolve(0));
    };
    process.on('SIGINT', () => close('SIGINT'));
    process.on('SIGTERM', () => close('SIGTERM'));
    process.on('SIGBREAK', () => close('SIGBREAK'));
    // PM2 en Windows (shutdown_with_message) envía este mensaje en lugar de una señal.
    process.on('message', (msg) => {
      if (msg === 'shutdown') close('pm2-message');
    });
  });
}
