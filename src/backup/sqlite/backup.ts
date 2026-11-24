import fs from 'node:fs/promises';
import path from 'node:path';
import { BackupError } from '../../util/errors.js';
import type { ToolRunner } from '../../util/process.js';
import { gzipFile, type StreamStats } from '../gzip.js';

function sqlitePathArg(p: string): string {
  if (/['\r\n\0]/.test(p)) {
    throw new BackupError('UNSAFE_NAME', 'La ruta contiene caracteres no permitidos para sqlite3 (comilla simple o saltos de línea).');
  }
  return p.replace(/\\/g, '/');
}

export interface SqliteBackupParams {
  command: string;
  sourcePath: string;
  /** Copia intermedia sin comprimir (en runtime/temp). */
  tempCopyPath: string;
  partialPath: string;
  gzipLevel: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SqliteBackupResult extends StreamStats {
  checks: string[];
}

/**
 * Respaldo consistente con `.backup` de SQLite (maneja WAL/SHM), verificación PRAGMA integrity_check
 * sobre la COPIA y compresión por streaming. El original solo se abre para lectura de respaldo.
 */
export async function backupSqliteFile(runner: ToolRunner, p: SqliteBackupParams): Promise<SqliteBackupResult> {
  const checks: string[] = [];
  let st;
  try {
    st = await fs.stat(p.sourcePath);
  } catch {
    throw new BackupError('SOURCE_MISSING', `No existe la base SQLite: ${p.sourcePath}`);
  }
  if (!st.isFile()) throw new BackupError('SOURCE_MISSING', `La ruta no es un archivo: ${p.sourcePath}`);

  await fs.rm(p.tempCopyPath, { force: true });
  try {
    const res = await runner.run(
      p.command,
      [p.sourcePath, '.timeout 15000', `.backup '${sqlitePathArg(p.tempCopyPath)}'`],
      { timeoutMs: p.timeoutMs, signal: p.signal },
    );
    if (res.code !== 0 || /error/i.test(res.stderr)) {
      throw new BackupError('TOOL_FAILED', `sqlite3 .backup falló (código ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
    }

    // 1-2. Existe y no está vacía
    let copy;
    try {
      copy = await fs.stat(p.tempCopyPath);
    } catch {
      throw new BackupError('VALIDATION_FAILED', 'sqlite3 no generó la copia.');
    }
    if (copy.size === 0) throw new BackupError('VALIDATION_FAILED', 'La copia SQLite está vacía.');
    checks.push('copia existe y no está vacía');

    // 3-4. integrity_check sobre la copia = ok
    const integ = await runner.run(p.command, [p.tempCopyPath, 'PRAGMA integrity_check;'], {
      timeoutMs: p.timeoutMs,
      signal: p.signal,
    });
    if (integ.code !== 0 || integ.stdout.trim() !== 'ok') {
      throw new BackupError('VALIDATION_FAILED', `PRAGMA integrity_check no devolvió "ok": ${(integ.stdout || integ.stderr).trim().slice(0, 300)}`);
    }
    checks.push('PRAGMA integrity_check = ok');

    // 5-6. SHA-256 (del contenido) y compresión
    const stats = await gzipFile(p.tempCopyPath, p.partialPath, p.gzipLevel, p.signal);
    checks.push('compresión gzip');
    return { ...stats, checks };
  } finally {
    await fs.rm(p.tempCopyPath, { force: true });
    await fs.rm(`${p.tempCopyPath}-wal`, { force: true });
    await fs.rm(`${p.tempCopyPath}-shm`, { force: true });
  }
}

export function tempCopyName(tempDir: string, runId: string, id: string): string {
  return path.join(tempDir, `sqlite-${runId}-${id}.partial-db`);
}
