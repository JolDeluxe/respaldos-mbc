import cron, { type ScheduledTask } from 'node-cron';
import { runBackup } from '../backup/runner.js';
import { evaluateRecovery } from '../recovery/recovery.js';
import { BackupError, errMessage } from '../util/errors.js';
import type { AppContext } from '../context.js';
import type { RunType } from '../types.js';

/**
 * Programador diario (node-cron, noOverlap) + recuperación al iniciar + apagado ordenado.
 * Una sola ejecución a la vez dentro del proceso; entre procesos protege el bloqueo persistente.
 */
export class BackupScheduler {
  private task?: ScheduledTask;
  private active?: Promise<unknown>;
  private abort?: AbortController;
  private stopping = false;
  private recoveryTimer?: NodeJS.Timeout;

  constructor(
    private readonly ctx: AppContext,
    private readonly run: typeof runBackup = runBackup,
  ) {}

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  start(): void {
    const { env } = this.ctx.cfg;
    this.task = cron.schedule(env.CRON_EXPRESSION, () => this.trigger('SCHEDULED'), {
      timezone: env.TIMEZONE,
      noOverlap: true,
      name: 'mbc-backup-daily',
    });
    this.ctx.log.info(
      { cron: env.CRON_EXPRESSION, timezone: env.TIMEZONE, next: this.task.getNextRun()?.toISOString() },
      'Programador iniciado',
    );
  }

  nextRun(): Date | null {
    return this.task?.getNextRun() ?? null;
  }

  /** Decide (y programa con retardo) una única copia RECOVERY si se perdió la ejecución diaria. */
  async scheduleRecoveryIfNeeded(): Promise<boolean> {
    const { env } = this.ctx.cfg;
    const state = await this.ctx.state.read();
    const d = evaluateRecovery(this.ctx.now(), state, env.CRON_EXPRESSION, env.TIMEZONE, env.RECOVERY_ENABLED);
    this.ctx.log.info({ needed: d.needed, reason: d.reason }, 'Evaluación de recuperación al iniciar');
    if (!d.needed) return false;
    this.ctx.log.warn({ slot: d.slot?.toISOString(), delaySeconds: env.RECOVERY_DELAY_SECONDS }, 'Se perdió una ejecución diaria: se programa una copia RECOVERY');
    this.recoveryTimer = setTimeout(() => void this.trigger('RECOVERY'), env.RECOVERY_DELAY_SECONDS * 1000);
    this.recoveryTimer.unref();
    return true;
  }

  trigger(type: RunType): Promise<unknown> | undefined {
    if (this.stopping) return undefined;
    if (this.active) {
      this.ctx.log.warn({ type }, 'Ejecución omitida: ya hay una en curso en este proceso');
      return undefined;
    }
    this.abort = new AbortController();
    const p = this.run(this.ctx, { type, signal: this.abort.signal, shouldStop: () => this.stopping })
      .catch((err) => {
        if (err instanceof BackupError && err.code === 'LOCK_HELD') {
          this.ctx.log.warn({ type }, `Ejecución omitida: ${err.message}`);
        } else {
          this.ctx.log.error({ type, err: errMessage(err) }, 'La ejecución terminó con error');
        }
      })
      .finally(() => {
        this.active = undefined;
        this.abort = undefined;
      });
    this.active = p;
    return p;
  }

  /**
   * Apagado ordenado: detiene el programador, deja terminar la base en curso durante `graceMs`;
   * si no alcanza, cancela (mata mysqldump/sqlite3, limpia .partial) y espera el cierre.
   */
  async shutdown(graceMs: number): Promise<'idle' | 'completed' | 'aborted'> {
    this.stopping = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    await this.task?.stop();
    await this.task?.destroy();
    const active = this.active;
    if (!active) return 'idle';
    this.ctx.log.warn({ graceMs }, 'Apagado solicitado con una ejecución activa: esperando que termine la base en curso');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceMs);
    });
    const outcome = await Promise.race([active.then(() => 'done' as const), timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === 'done') return 'completed';
    this.ctx.log.warn('Tiempo de gracia agotado: cancelando la ejecución activa');
    this.abort?.abort();
    await Promise.race([active, new Promise((r) => setTimeout(r, 20_000))]);
    return 'aborted';
  }
}
