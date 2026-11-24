import type { MysqlInstanceConfig } from './config/schema.js';

export type Engine = 'mysql' | 'sqlite';
export type RunType = 'SCHEDULED' | 'MANUAL' | 'RECOVERY';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'aborted' | 'interrupted';

/** Unidad respaldable (un esquema MySQL o un archivo SQLite). */
export interface BackupTarget {
  /** Clave única, p. ej. "mysql:principal:calidad_mbc" o "sqlite:kpis". */
  key: string;
  engine: Engine;
  /** Identificador de la base (esquema MySQL o id SQLite). */
  databaseId: string;
  instanceId?: string;
  /** Nombre del esquema o ruta del archivo original. */
  sourceName: string;
  displayName: string;
  /** Segmentos de directorio ya sanitizados bajo <root>/<engine>/. */
  segments: string[];
  estimatedBytes: number;
  mysql?: MysqlInstanceConfig;
  sqlitePath?: string;
  warnings?: string[];
}

export interface Manifest {
  schemaVersion: 1;
  databaseId: string;
  engine: Engine;
  instanceId?: string;
  sourceName: string;
  displayName: string;
  runId: string;
  runType: RunType;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  contentSha256: string;
  contentBytes: number;
  validation: { result: 'ok' | 'failed'; checks: string[] };
  tool: { name: string; version: string };
  serverVersion?: string;
  status: 'success';
}

export interface DbResult {
  key: string;
  engine: Engine;
  databaseId: string;
  sourceName: string;
  status: 'success' | 'failed' | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  sizeBytes?: number;
  sha256?: string;
  file?: string;
  error?: string;
  skippedReason?: string;
  retention?: { kept: number; deleted: string[]; errors: string[] };
}

export interface RunRecord {
  runId: string;
  type: RunType;
  dryRun: boolean;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  node: string;
  freeBytesAtStart?: number;
  discovered: { mysql: Array<{ instanceId: string; schemas: string[] }>; sqlite: string[] };
  results: DbResult[];
  errors: string[];
}

export interface ServiceState {
  schemaVersion: 1;
  /** Primera vez que el servicio inició en esta instalación (línea base de recuperación). */
  firstSeenAt?: string;
  lastStartAt?: string;
  currentRun?: { runId: string; type: RunType; startedAt: string; pid: number };
  lastRun?: { runId: string; type: RunType; status: RunStatus; startedAt: string; finishedAt?: string; ok: number; failed: number; skipped: number };
  /** Fin de la última ejecución con estado success/partial. */
  lastCompletedAt?: string;
  lastRecoveryAt?: string;
}
