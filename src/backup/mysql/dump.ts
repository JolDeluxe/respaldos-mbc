import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { MysqlInstanceConfig } from '../../config/schema.js';
import { BackupError } from '../../util/errors.js';
import { fsyncFile } from '../../util/fsx.js';
import { redactSecrets, type ToolRunner } from '../../util/process.js';
import { TapTransform, type StreamStats } from '../gzip.js';

const execFileAsync = promisify(execFile);

/**
 * Opciones de mysqldump (compatibles con MySQL 8.0 y 8.4):
 *  --single-transaction   instantánea consistente de InnoDB sin bloquear escrituras
 *  --quick                lee fila por fila (sin cargar tablas completas en memoria)
 *  --routines/--events/--triggers  objetos programables (según permisos)
 *  --hex-blob             BLOB/BINARY seguros en el volcado
 *  --no-tablespaces       evita requerir el privilegio PROCESS
 *  --set-gtid-purged=OFF  el volcado no incluye sentencias GTID (se restaura en cualquier servidor)
 *  --databases            incluye CREATE DATABASE/USE para restauraciones autocontenidas
 */
export function buildMysqldumpArgs(optionsFile: string, schema: string): string[] {
  return [
    `--defaults-extra-file=${optionsFile}`, // debe ser el primer argumento
    '--single-transaction',
    '--quick',
    '--routines',
    '--events',
    '--triggers',
    '--hex-blob',
    '--no-tablespaces',
    '--set-gtid-purged=OFF',
    '--default-character-set=utf8mb4',
    '--max-allowed-packet=64M',
    '--databases',
    '--',
    schema,
  ];
}

function quoteOptionValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '')}"`;
}

/** Aplica ACLs restrictivas en Windows (NTFS) usando icacls. */
export async function secureFileAclWindows(file: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    // /inheritance:r elimina permisos heredados
    // *S-1-5-18 = NT AUTHORITY\SYSTEM
    // *S-1-5-32-544 = BUILTIN\Administrators
    // %USERNAME% = usuario actual que ejecuta el servicio
    const user = process.env.USERNAME || process.env.USER || '';
    const args = [
      file,
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-18:(F)',
      '*S-1-5-32-544:(F)',
    ];
    if (user) {
      args.push(`${user}:(F)`);
    }
    await execFileAsync('icacls.exe', args, { windowsHide: true });
  } catch {
    // Si icacls falla en algún entorno de prueba o contenedor, no aborta el flujo,
    // pero el archivo fue creado con flag 'wx' y mode 0o600.
  }
}

/** Archivo de opciones temporal con las credenciales (nunca en argumentos de línea de comandos). */
export async function writeOptionsFile(tempDir: string, instance: MysqlInstanceConfig, password: string): Promise<string> {
  await fs.mkdir(tempDir, { recursive: true });
  const file = path.join(tempDir, `mysqldump-${process.pid}-${randomBytes(6).toString('hex')}.cnf`);
  const body = [
    '[client]',
    `user=${quoteOptionValue(instance.user)}`,
    `password=${quoteOptionValue(password)}`,
    `host=${quoteOptionValue(instance.host)}`,
    `port=${instance.port}`,
    '',
  ].join('\n');
  await fs.writeFile(file, body, { flag: 'wx', mode: 0o600 });
  await secureFileAclWindows(file);
  return file;
}

export async function removeOptionsFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

export interface MysqlDumpParams {
  command: string;
  instance: MysqlInstanceConfig;
  schema: string;
  password: string;
  tempDir: string;
  partialPath: string;
  gzipLevel: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

const DUMP_COMPLETED = /-- Dump completed/;

export async function dumpMysqlSchema(runner: ToolRunner, p: MysqlDumpParams): Promise<StreamStats> {
  const optionsFile = await writeOptionsFile(p.tempDir, p.instance, p.password);
  try {
    const handle = runner.stream(p.command, buildMysqldumpArgs(optionsFile, p.schema), {
      timeoutMs: p.timeoutMs,
      signal: p.signal,
    });
    const tap = new TapTransform();
    const [pipe, done] = await Promise.allSettled([
      pipeline(handle.stdout, tap, createGzip({ level: p.gzipLevel }), createWriteStream(p.partialPath, { flags: 'wx' }), {
        signal: p.signal,
      }),
      handle.done,
    ]);
    if (done.status === 'fulfilled') {
      const d = done.value;
      if (d.aborted || p.signal?.aborted) throw new BackupError('ABORTED', 'Exportación cancelada.');
      if (d.spawnError) {
        const missing = /ENOENT/.test(d.spawnError);
        throw new BackupError(missing ? 'TOOL_MISSING' : 'TOOL_FAILED', `No se pudo ejecutar mysqldump: ${redactSecrets(d.spawnError, [p.password])}`);
      }
      if (d.timedOut) throw new BackupError('TOOL_FAILED', 'mysqldump excedió el tiempo máximo permitido.');
      if (d.code !== 0) {
        const msg = redactSecrets(d.stderrTail, [p.password]).trim().split(/\r?\n/).slice(-3).join(' | ');
        throw new BackupError('TOOL_FAILED', `mysqldump terminó con código ${d.code}: ${msg}`);
      }
    }
    if (pipe.status === 'rejected') {
      if (p.signal?.aborted) throw new BackupError('ABORTED', 'Exportación cancelada.');
      throw new BackupError('TOOL_FAILED', `Fallo al escribir el volcado: ${(pipe.reason as Error).message}`);
    }
    await fsyncFile(p.partialPath);
    if (!DUMP_COMPLETED.test(tap.tail)) {
      throw new BackupError('VALIDATION_FAILED', 'El volcado MySQL está incompleto (falta la marca "Dump completed").');
    }
    return { contentSha256: tap.digest(), contentBytes: tap.bytes, tail: tap.tail };
  } finally {
    await removeOptionsFile(optionsFile);
  }
}
