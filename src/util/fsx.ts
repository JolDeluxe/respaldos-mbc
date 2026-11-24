import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BackupError } from './errors.js';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Convierte un nombre arbitrario (p. ej. de un esquema MySQL) en un segmento de ruta seguro.
 * La codificación es inyectiva: todo byte fuera de [A-Za-z0-9_-] pasa a "~HH".
 * Así nunca puede producir separadores, "..", ni nombres reservados de Windows.
 */
export function safeSegment(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new BackupError('UNSAFE_NAME', 'Nombre vacío no permitido como segmento de ruta.');
  }
  let out = '';
  for (const byte of Buffer.from(name, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_-]/.test(ch) ? ch : `~${byte.toString(16).padStart(2, '0')}`;
  }
  if (WINDOWS_RESERVED.test(out)) {
    out = `~${out.charCodeAt(0).toString(16).padStart(2, '0')}${out.slice(1)}`;
  }
  if (out.length > 120) {
    throw new BackupError('UNSAFE_NAME', `Nombre demasiado largo para usarse como directorio (${name.length} caracteres).`);
  }
  return out;
}

/** Une segmentos bajo `root` y garantiza que el resultado no escape de `root`. */
export function resolveInside(root: string, ...parts: string[]): string {
  const rootResolved = path.resolve(root);
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || /[\\/\0:]/.test(p)) {
      throw new BackupError('PATH_ESCAPE', `Segmento de ruta no permitido: ${JSON.stringify(p)}`);
    }
  }
  const full = path.resolve(rootResolved, ...parts);
  if (!isInside(rootResolved, full) || full === rootResolved) {
    throw new BackupError('PATH_ESCAPE', 'La ruta resultante queda fuera del directorio autorizado.');
  }
  return full;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i + 1 >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** Escritura atómica: archivo temporal + fsync + rename. Tolera apagados inesperados. */
export async function atomicWriteFile(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function fsyncFile(file: string): Promise<void> {
  const h = await fs.open(file, 'r+');
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
