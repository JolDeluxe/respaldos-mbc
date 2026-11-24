import fs from 'node:fs/promises';
import path from 'node:path';
import { PARTIAL_FILE_RE } from '../storage/layout.js';
import { inspectLock } from '../storage/lock.js';
import { lastScheduledSlot, parseDailyCron } from '../util/time.js';
import type { AppContext } from '../context.js';
import type { ServiceState } from '../types.js';

export interface RecoveryDecision {
  needed: boolean;
  reason: string;
  slot?: Date;
}

/**
 * ¿Se perdió la ejecución diaria? Se compara el último instante programado ya vencido con el fin de la
 * última ejecución completada (o, si nunca hubo, con la primera vez que el servicio inició).
 * Devuelve a lo sumo UNA recuperación, sin importar cuántos días se hayan perdido.
 */
export function evaluateRecovery(now: Date, state: ServiceState, cronExpr: string, tz: string, enabled = true): RecoveryDecision {
  if (!enabled) return { needed: false, reason: 'recuperación deshabilitada' };
  const daily = parseDailyCron(cronExpr);
  if (!daily) return { needed: false, reason: 'la expresión cron no es diaria simple; recuperación no aplicable' };
  const baselineIso = state.lastCompletedAt ?? state.firstSeenAt;
  if (!baselineIso) return { needed: false, reason: 'primera ejecución del servicio: sin línea base' };
  const slot = lastScheduledSlot(now, tz, daily);
  const baseline = new Date(baselineIso);
  if (baseline.getTime() >= slot.getTime()) return { needed: false, reason: 'la ejecución programada más reciente ya fue cubierta', slot };
  return { needed: true, reason: `última ejecución completada: ${state.lastCompletedAt ?? 'ninguna'}; se perdió la programada de ${slot.toISOString()}`, slot };
}

/** Marca como interrumpida una ejecución que quedó "en curso" si ya no hay un proceso legítimo con el bloqueo. */
export async function reconcileInterruptedRun(ctx: AppContext, opts: { lockHeldByUs?: boolean } = {}): Promise<string | undefined> {
  const state = await ctx.state.read();
  const cur = state.currentRun;
  if (!cur) return undefined;
  if (!opts.lockHeldByUs) {
    const lock = await inspectLock(ctx.cfg.paths.lockFile, ctx.cfg.env.LOCK_STALE_MINUTES * 60_000);
    if (lock.present && lock.active) return undefined; // una instancia legítima sigue ejecutando
  }
  const rec = await ctx.state.readRun(cur.runId);
  if (rec && rec.status === 'running') {
    rec.status = 'interrupted';
    rec.finishedAt = ctx.now().toISOString();
    rec.errors.push('Ejecución interrumpida (el proceso terminó inesperadamente).');
    await ctx.state.writeRun(rec);
  }
  await ctx.state.update((s) => {
    s.lastRun = { runId: cur.runId, type: cur.type, status: 'interrupted', startedAt: cur.startedAt, finishedAt: ctx.now().toISOString(), ok: 0, failed: 0, skipped: 0 };
    delete s.currentRun;
  });
  ctx.log.warn({ runId: cur.runId }, 'Se detectó una ejecución interrumpida previa');
  return cur.runId;
}

async function removeIfOld(file: string, maxAgeMs: number, now: number): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    if (st.isFile() && now - st.mtimeMs >= maxAgeMs) {
      await fs.rm(file, { force: true });
      return true;
    }
  } catch {
    /* ignorar */
  }
  return false;
}

async function walkPartials(dir: string, depth: number, maxAgeMs: number, now: number, removed: string[]): Promise<void> {
  if (depth > 5) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkPartials(full, depth + 1, maxAgeMs, now, removed);
    else if (e.isFile() && PARTIAL_FILE_RE.test(e.name) && (await removeIfOld(full, maxAgeMs, now))) removed.push(full);
  }
}

/**
 * Limpia archivos temporales ABANDONADOS propios del servicio. Debe llamarse con el bloqueo adquirido
 * (garantiza que ninguna operación activa los usa) y respeta una antigüedad mínima.
 */
export async function cleanOrphans(ctx: AppContext): Promise<string[]> {
  const removed: string[] = [];
  const maxAgeMs = ctx.cfg.env.TEMP_MAX_AGE_HOURS * 3_600_000;
  const now = Date.now();
  try {
    for (const name of await fs.readdir(ctx.cfg.paths.tempDir)) {
      if (/^(?:mysqldump-.*\.cnf|sqlite-.*\.partial-db(?:-wal|-shm)?|.*\.partial)$/.test(name)) {
        const full = path.join(ctx.cfg.paths.tempDir, name);
        if (await removeIfOld(full, maxAgeMs, now)) removed.push(full);
      }
    }
  } catch {
    /* el directorio temporal puede no existir */
  }
  for (const engine of ['mysql', 'sqlite']) {
    await walkPartials(path.join(ctx.cfg.paths.backupRoot, engine), 0, maxAgeMs, now, removed);
  }
  if (removed.length) ctx.log.warn({ removed }, 'Archivos temporales abandonados eliminados');
  return removed;
}
