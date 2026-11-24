import { BackupError, errMessage } from '../util/errors.js';
import type { AppContext } from '../context.js';

export interface ToolStatus {
  name: 'mysqldump' | 'sqlite3';
  path: string;
  ok: boolean;
  version?: string;
  error?: string;
}

export async function checkMysqldump(ctx: AppContext): Promise<ToolStatus> {
  const path = ctx.cfg.env.MYSQLDUMP_PATH;
  try {
    const r = await ctx.runner.run(path, ['--version'], { timeoutMs: 15000 });
    const m = /Ver\s+([\d.]+)/.exec(r.stdout);
    if (r.code !== 0 || !m) throw new BackupError('TOOL_FAILED', `Salida inesperada de mysqldump --version: ${r.stdout.trim().slice(0, 120)}`);
    return { name: 'mysqldump', path, ok: true, version: m[1] };
  } catch (err) {
    return { name: 'mysqldump', path, ok: false, error: errMessage(err) };
  }
}

export async function checkSqlite3(ctx: AppContext): Promise<ToolStatus> {
  const path = ctx.cfg.env.SQLITE3_PATH;
  try {
    const r = await ctx.runner.run(path, ['-version'], { timeoutMs: 15000 });
    const m = /^(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(r.stdout.trim());
    if (r.code !== 0 || !m) throw new BackupError('TOOL_FAILED', `Salida inesperada de sqlite3 -version: ${r.stdout.trim().slice(0, 120)}`);
    return { name: 'sqlite3', path, ok: true, version: m[1] };
  } catch (err) {
    return { name: 'sqlite3', path, ok: false, error: errMessage(err) };
  }
}

/** Compara versiones mayor.menor; devuelve true si `client` es más antigua que `server`. */
export function clientOlderThanServer(client: string, server: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const [cM = 0, cm = 0] = parse(client);
  const [sM = 0, sm = 0] = parse(server);
  return cM < sM || (cM === sM && cm < sm);
}
