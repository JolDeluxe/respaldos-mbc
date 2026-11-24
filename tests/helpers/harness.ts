import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { buildPaths, parseDatabases, parseEnv, type AppConfig } from '../../src/config/load.js';
import type { DatabasesFile } from '../../src/config/schema.js';
import { createContext, type AppContext } from '../../src/context.js';
import type { MysqlConnector, SchemaInfo } from '../../src/discovery/mysql.js';
import { createMemoryLogger } from '../../src/logging/logger.js';
import { BackupError } from '../../src/util/errors.js';
import type { RunOptions, RunResult, StreamHandle, ToolRunner } from '../../src/util/process.js';

export const FAKE_SQLITE = 'sqlite3-fake';
export const FAKE_MYSQLDUMP = 'mysqldump-fake';
export const TEST_PASSWORD = 'S3cr3t-P@ss-do-not-log';

export async function makeTmp(prefix = 'mbc-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export interface Harness {
  tmp: string;
  cfg: AppConfig;
  ctx: AppContext;
  runner: FakeRunner;
  mysql: FakeMysql;
  logLines: string[];
  clock: { now: Date };
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  databases?: unknown;
  env?: Record<string, string>;
  free?: number;
  now?: Date;
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const tmp = await makeTmp();
  const env = parseEnv({
    MBC_MODE: 'production',
    BACKUP_ROOT: path.join(tmp, 'Respaldos', 'Diarios'),
    RUNTIME_DIR: path.join(tmp, 'runtime'),
    CONFIG_PATH: path.join(tmp, 'no-existe.json'),
    SQLITE3_PATH: FAKE_SQLITE,
    MYSQLDUMP_PATH: FAKE_MYSQLDUMP,
    MIN_FREE_GB: '0',
    LOCK_STALE_MINUTES: '10',
    TEMP_MAX_AGE_HOURS: '1',
    ...opts.env,
  } as NodeJS.ProcessEnv);
  const databases: DatabasesFile = parseDatabases(
    opts.databases ?? {
      mysql: [{ id: 'principal', host: '127.0.0.1', user: 'mbc_backup', passwordEnv: 'TEST_MYSQL_PWD' }],
      sqlite: [],
    },
  );
  const cfg: AppConfig = { env, databases, paths: buildPaths(env, tmp) };
  const runner = new FakeRunner();
  const mysql = new FakeMysql();
  const logLines: string[] = [];
  const clock = { now: opts.now ?? new Date('2026-11-24T10:00:00-06:00') };
  const ctx = createContext(cfg, createMemoryLogger(logLines), {
    runner,
    mysql,
    secrets: { TEST_MYSQL_PWD: TEST_PASSWORD },
    now: () => new Date(clock.now),
    freeBytes: async () => opts.free ?? 500 * 1024 ** 3,
  });
  return { tmp, cfg, ctx, runner, mysql, logLines, clock, cleanup: () => fs.rm(tmp, { recursive: true, force: true }) };
}

export class FakeMysql implements MysqlConnector {
  schemas: SchemaInfo[] = [];
  failInstances = new Set<string>();
  version = '8.4.3';
  async listSchemas(instance: { id: string }) {
    if (this.failInstances.has(instance.id)) {
      throw new BackupError('CONNECTION_FAILED', `No se pudo conectar a MySQL "${instance.id}": ECONNREFUSED`);
    }
    return { serverVersion: this.version, schemas: this.schemas, warnings: [] };
  }
}

export const schema = (name: string, extra: Partial<SchemaInfo> = {}): SchemaInfo => ({
  name,
  estimatedBytes: 1000,
  nonInnodbTables: 0,
  ...extra,
});

/** Simula sqlite3.exe (con node:sqlite) y mysqldump (flujo sintético). */
export class FakeRunner implements ToolRunner {
  streamCalls: Array<{ command: string; args: string[]; optionsFileExistedAtStart: boolean; optionsFileContent: string }> = [];
  runCalls: Array<{ command: string; args: string[] }> = [];
  failDumpSchemas = new Set<string>();
  incompleteDumpSchemas = new Set<string>();
  /** El volcado de este esquema se queda esperando hasta que se aborte la señal. */
  hangSchemas = new Set<string>();
  failBackupIds = new Set<string>();
  corruptIntegrity = false;
  missingTools = new Set<string>();
  dumpLines = 2000;
  active = 0;
  maxActive = 0;
  hangStarted?: () => void;

  async run(command: string, args: string[], options?: RunOptions): Promise<RunResult> {
    this.runCalls.push({ command, args });
    if (this.missingTools.has(command)) throw new BackupError('TOOL_MISSING', `No se encontró el ejecutable: ${command}`);
    this.enter();
    try {
      if (command === FAKE_MYSQLDUMP) {
        return { code: 0, stdout: 'mysqldump  Ver 8.4.0 for Win64 on x86_64 (MySQL Community Server - GPL)\n', stderr: '' };
      }
      if (command === FAKE_SQLITE) {
        if (args[0] === '-version') return { code: 0, stdout: '3.45.1 2024-01-30 16:01:20 (64-bit)\n', stderr: '' };
        if (args[2]?.startsWith('.backup')) {
          const src = args[0]!;
          const m = /^\.backup '(.*)'$/.exec(args[2])!;
          const dest = m[1]!;
          if (this.failBackupIds.has(path.basename(src))) return { code: 1, stdout: '', stderr: 'Error: database is locked' };
          const db = new DatabaseSync(src, { readOnly: false });
          try {
            await sqliteBackup(db, dest);
          } finally {
            db.close();
          }
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[1] === 'PRAGMA integrity_check;') {
          if (this.corruptIntegrity) return { code: 0, stdout: '*** in database main ***\nPage 2: btree error\n', stderr: '' };
          const db = new DatabaseSync(args[0]!, { readOnly: true });
          try {
            const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
            return { code: 0, stdout: `${row.integrity_check}\n`, stderr: '' };
          } finally {
            db.close();
          }
        }
      }
      void options;
      return { code: 1, stdout: '', stderr: `comando no soportado por el simulador: ${command} ${args.join(' ')}` };
    } finally {
      this.leave();
    }
  }

  stream(command: string, args: string[], options?: RunOptions): StreamHandle {
    const optFlag = args.find((a) => a.startsWith('--defaults-extra-file='));
    const optFile = optFlag?.slice('--defaults-extra-file='.length);
    const schemaName = args[args.length - 1]!;
    const call = { command, args, optionsFileExistedAtStart: false, optionsFileContent: '' };
    this.streamCalls.push(call);
    this.enter();
    const self = this;
    let aborted = false;
    const out = new Readable({ read() {} });
    let resolveDone!: (v: Awaited<StreamHandle['done']>) => void;
    const done: StreamHandle['done'] = new Promise((r) => (resolveDone = r));
    const finish = (code: number, stderrTail = '') => {
      self.leave();
      resolveDone({ code, stderrTail, timedOut: false, aborted });
    };
    void (async () => {
      if (optFile) {
        try {
          call.optionsFileContent = await fs.readFile(optFile, 'utf8');
          call.optionsFileExistedAtStart = true;
        } catch {
          /* ignorar */
        }
      }
      if (this.missingTools.has(command)) {
        out.destroy(new Error('spawn ENOENT'));
        self.leave();
        resolveDone({ code: null, stderrTail: '', spawnError: 'spawn ENOENT', timedOut: false, aborted: false });
        return;
      }
      if (this.hangSchemas.has(schemaName)) {
        out.push('-- MySQL dump (parcial)\n');
        this.hangStarted?.();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve();
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        aborted = true;
        out.destroy(new Error('abortado'));
        finish(null as unknown as number);
        return;
      }
      out.push(`-- MySQL dump 10.13  Distrib 8.4.0\nCREATE DATABASE \`${schemaName}\`;\nUSE \`${schemaName}\`;\n`);
      for (let i = 0; i < this.dumpLines; i++) {
        out.push(`INSERT INTO t VALUES (${i},'fila sintética ${i}');\n`);
        if (i % 500 === 0) await new Promise((r) => setImmediate(r));
      }
      if (this.failDumpSchemas.has(schemaName)) {
        out.push(null);
        finish(2, `mysqldump: Got error: 1045: Access denied (using password: YES) ${TEST_PASSWORD}`);
        return;
      }
      if (!this.incompleteDumpSchemas.has(schemaName)) out.push('-- Dump completed on 2026-11-24 23:59:00\n');
      out.push(null);
      finish(0);
    })();
    return { stdout: out, done };
  }

  private enter() {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
  }
  private leave() {
    this.active--;
  }
}

/** Crea una base SQLite real (WAL) con datos sintéticos; devuelve la conexión abierta para simular uso concurrente. */
export function makeSqliteDb(file: string, rows = 200): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE kpi (id INTEGER PRIMARY KEY, valor TEXT);');
  const ins = db.prepare('INSERT INTO kpi (valor) VALUES (?)');
  for (let i = 0; i < rows; i++) ins.run(`dato-${i}`);
  return db;
}
