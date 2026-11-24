import fs from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { BackupError } from '../util/errors.js';
import { atomicWriteFile } from '../util/fsx.js';

export interface LockInfo {
  pid: number;
  token: string;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  runId?: string;
}

export interface LockHandle {
  readonly token: string;
  release(): Promise<void>;
}

export interface LockOptions {
  /** Un bloqueo cuyo latido sea más antiguo que esto se considera abandonado. */
  staleMs: number;
  isPidAlive?: (pid: number) => boolean;
  now?: () => Date;
  runId?: string;
  heartbeatMs?: number;
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLock(file: string): Promise<LockInfo | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

/**
 * Bloqueo persistente exclusivo (archivo creado con O_EXCL).
 * Un bloqueo existente solo se reclama si NO hay un proceso vivo con latido reciente.
 */
export async function acquireLock(file: string, options: LockOptions): Promise<LockHandle> {
  const now = options.now ?? (() => new Date());
  const alive = options.isPidAlive ?? defaultIsPidAlive;
  const token = randomBytes(8).toString('hex');
  await fs.mkdir(path.dirname(file), { recursive: true });

  const info = (): LockInfo => ({
    pid: process.pid,
    token,
    hostname: os.hostname(),
    startedAt: startedAt.toISOString(),
    heartbeatAt: now().toISOString(),
    runId: options.runId,
  });
  const startedAt = now();

  const tryCreate = async (): Promise<boolean> => {
    try {
      const h = await fs.open(file, 'wx');
      try {
        await h.writeFile(JSON.stringify(info(), null, 2));
        await h.sync();
      } finally {
        await h.close();
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  if (!(await tryCreate())) {
    const existing = await readLock(file);
    let stale = false;
    if (!existing) {
      // Archivo ilegible: solo se reclama si es antiguo (podría estar escribiéndose).
      const st = await fs.stat(file).catch(() => undefined);
      stale = !st || now().getTime() - st.mtimeMs > options.staleMs;
    } else {
      const age = now().getTime() - new Date(existing.heartbeatAt).getTime();
      stale = !(alive(existing.pid) && age <= options.staleMs);
    }
    if (!stale) {
      throw new BackupError(
        'LOCK_HELD',
        `Ya existe una ejecución en curso (PID ${existing?.pid ?? '?'}, desde ${existing?.startedAt ?? '?'}).`,
      );
    }
    // Reclamación segura: renombrar de forma atómica; solo uno puede hacerlo con éxito.
    const aside = `${file}.stale-${token}`;
    try {
      await fs.rename(file, aside);
      await fs.rm(aside, { force: true });
    } catch {
      throw new BackupError('LOCK_HELD', 'No se pudo reclamar el bloqueo abandonado (otra instancia lo está reclamando).');
    }
    if (!(await tryCreate())) {
      throw new BackupError('LOCK_HELD', 'Otra instancia obtuvo el bloqueo primero.');
    }
  }

  const heartbeatMs = options.heartbeatMs ?? Math.max(1000, Math.min(30_000, Math.floor(options.staleMs / 4)));
  const timer = setInterval(() => {
    void (async () => {
      const cur = await readLock(file);
      if (cur?.token === token) await atomicWriteFile(file, JSON.stringify(info(), null, 2)).catch(() => undefined);
    })();
  }, heartbeatMs);
  timer.unref();

  return {
    token,
    async release() {
      clearInterval(timer);
      const cur = await readLock(file);
      if (cur?.token === token) await fs.rm(file, { force: true });
    },
  };
}

export async function inspectLock(file: string, staleMs: number, isPidAlive = defaultIsPidAlive) {
  const info = await readLock(file);
  if (!info) return { present: false as const };
  const age = Date.now() - new Date(info.heartbeatAt).getTime();
  return { present: true as const, info, active: isPidAlive(info.pid) && age <= staleMs };
}
