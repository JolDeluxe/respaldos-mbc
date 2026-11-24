import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import type { ZodError } from 'zod';
import { BackupError } from '../util/errors.js';
import { isValidTimeZone } from '../util/time.js';
import { databasesFileSchema, envSchema, type DatabasesFile, type EnvConfig } from './schema.js';

export interface AppPaths {
  baseDir: string;
  backupRoot: string;
  runtimeDir: string;
  logDir: string;
  stateDir: string;
  runsDir: string;
  tempDir: string;
  configPath: string;
  stateFile: string;
  lockFile: string;
}

export interface AppConfig {
  env: EnvConfig;
  databases: DatabasesFile;
  paths: AppPaths;
}

export const REQUIRED_NODE = '>=22.18.0 <23 || >=26.0.0';

/** Comprueba la versión de Node.js: 22.18+ (rama 22) o 26+. */
export function isSupportedNode(version: string): boolean {
  const [maj = 0, min = 0] = version.replace(/^v/, '').split('.').map(Number);
  return (maj === 22 && min >= 18) || maj >= 26;
}

export function assertNodeVersion(version = process.versions.node): void {
  if (!isSupportedNode(version)) {
    throw new BackupError('NODE_VERSION', `Node.js ${version} no soportado. Se requiere ${REQUIRED_NODE}.`);
  }
}

function formatZod(err: ZodError, prefix: string): string {
  return err.issues.map((i) => `${prefix}${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`).join('\n');
}

/** Carga `.env` desde baseDir sin sobrescribir variables ya definidas (p. ej. por PM2). */
export function loadDotenv(baseDir: string): void {
  const file = path.join(baseDir, '.env');
  if (fs.existsSync(file)) dotenv.config({ path: file, quiet: true });
}

export function parseEnv(source: NodeJS.ProcessEnv): EnvConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new BackupError('CONFIG_INVALID', `Variables de entorno inválidas:\n${formatZod(parsed.error, '  - ')}`);
  }
  const env = parsed.data;
  if (!cron.validate(env.CRON_EXPRESSION)) {
    throw new BackupError('CONFIG_INVALID', `CRON_EXPRESSION inválida: "${env.CRON_EXPRESSION}"`);
  }
  if (!isValidTimeZone(env.TIMEZONE)) {
    throw new BackupError('CONFIG_INVALID', `TIMEZONE inválida: "${env.TIMEZONE}"`);
  }
  return env;
}

export function parseDatabases(raw: unknown): DatabasesFile {
  const parsed = databasesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BackupError('CONFIG_INVALID', `config/databases.json inválido:\n${formatZod(parsed.error, '  - ')}`);
  }
  return parsed.data;
}

export function readDatabasesFile(file: string): DatabasesFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new BackupError(
      'CONFIG_INVALID',
      `No se pudo leer ${file} (${(err as NodeJS.ErrnoException).code}). Copie config/databases.example.json a config/databases.json y ajústelo.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new BackupError('CONFIG_INVALID', `${file} no es JSON válido: ${(err as Error).message}`);
  }
  return parseDatabases(raw);
}

export function buildPaths(env: EnvConfig, baseDir: string): AppPaths {
  const runtimeDir = path.resolve(baseDir, env.RUNTIME_DIR);
  const stateDir = path.join(runtimeDir, 'state');
  const backupRoot = path.resolve(baseDir, env.BACKUP_ROOT);
  return {
    baseDir,
    backupRoot,
    runtimeDir,
    logDir: path.join(runtimeDir, 'logs'),
    stateDir,
    runsDir: path.join(stateDir, 'runs'),
    tempDir: path.join(runtimeDir, 'temp'),
    configPath: path.resolve(baseDir, env.CONFIG_PATH),
    stateFile: path.join(stateDir, 'state.json'),
    lockFile: path.join(stateDir, 'backup.lock'),
  };
}

export function loadAppConfig(source: NodeJS.ProcessEnv = process.env, baseDir = process.cwd()): AppConfig {
  assertNodeVersion();
  const env = parseEnv(source);
  const paths = buildPaths(env, baseDir);
  const databases = readDatabasesFile(paths.configPath);
  return { env, databases, paths };
}
