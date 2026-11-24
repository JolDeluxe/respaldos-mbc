import { spawn } from 'node:child_process';
import os from 'node:os';
import { PassThrough, type Readable } from 'node:stream';
import { BackupError } from './errors.js';

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Variables de entorno adicionales (se mezclan con process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface StreamHandle {
  stdout: Readable;
  done: Promise<{ code: number | null; stderrTail: string; spawnError?: string; timedOut: boolean; aborted: boolean }>;
}

/** Abstracción de ejecución de herramientas externas (mysqldump, sqlite3). Sustituible en pruebas. */
export interface ToolRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
  stream(command: string, args: string[], options?: RunOptions): StreamHandle;
}

const MAX_CAPTURE = 1024 * 1024;
const STDERR_TAIL = 8 * 1024;

function lowerPriority(pid: number | undefined): void {
  if (!pid) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* no crítico */
  }
}

function spawnTool(command: string, args: string[], options: RunOptions | undefined) {
  const child = spawn(command, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options?.env },
  });
  lowerPriority(child.pid);
  let timedOut = false;
  let aborted = false;
  const kill = () => {
    if (!child.killed) child.kill();
  };
  const timer = options?.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs)
    : undefined;
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (options?.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onAbort);
  };
  return { child, cleanup, flags: () => ({ timedOut, aborted }) };
}

export class NodeToolRunner implements ToolRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const { child, cleanup, flags } = spawnTool(command, args, options);
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8').on('data', (d: string) => {
        if (stdout.length < MAX_CAPTURE) stdout += d;
      });
      child.stderr!.setEncoding('utf8').on('data', (d: string) => {
        if (stderr.length < MAX_CAPTURE) stderr += d;
      });
      child.on('error', (err) => {
        cleanup();
        const code = (err as NodeJS.ErrnoException).code;
        reject(
          new BackupError(
            code === 'ENOENT' ? 'TOOL_MISSING' : 'TOOL_FAILED',
            code === 'ENOENT' ? `No se encontró el ejecutable: ${command}` : `No se pudo ejecutar ${command}: ${err.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        cleanup();
        const f = flags();
        if (f.aborted) return reject(new BackupError('ABORTED', `Ejecución cancelada: ${command}`));
        if (f.timedOut) return reject(new BackupError('TOOL_FAILED', `Tiempo de espera agotado: ${command}`));
        resolve({ code, stdout, stderr });
      });
    });
  }

  stream(command: string, args: string[], options?: RunOptions): StreamHandle {
    const { child, cleanup, flags } = spawnTool(command, args, options);
    const out = new PassThrough();
    child.stdout!.pipe(out);
    let stderrTail = '';
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-STDERR_TAIL);
    });
    const done: StreamHandle['done'] = new Promise((resolve) => {
      child.on('error', (err) => {
        cleanup();
        out.destroy(err);
        resolve({ code: null, stderrTail, spawnError: err.message, ...flags() });
      });
      child.on('close', (code) => {
        cleanup();
        resolve({ code, stderrTail, ...flags() });
      });
    });
    return { stdout: out, done };
  }
}

/** Elimina contraseñas conocidas de un texto antes de registrarlo. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}
