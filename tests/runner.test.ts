import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runBackup } from '../src/backup/runner.js';
import { BackupError } from '../src/util/errors.js';
import { listBackups, MANIFEST_SUFFIX } from '../src/storage/layout.js';
import { verifyBackups } from '../src/validation/verify.js';
import { createFakeBackup, listFilesRecursive, mysqlTarget, sqliteTarget } from './helpers/fixtures.js';
import { makeHarness, makeSqliteDb, schema, TEST_PASSWORD } from './helpers/harness.js';
import type { Manifest } from '../src/types.js';

const MYSQL_AND_SQLITE = (sqlitePath: string) => ({
  mysql: [{ id: 'principal', host: '127.0.0.1', user: 'mbc_backup', passwordEnv: 'TEST_MYSQL_PWD' }],
  sqlite: [{ id: 'kpis', path: sqlitePath }],
});

describe('Ejecución completa (#4-#13)', () => {
  it('respalda MySQL + SQLite, publica con manifiesto y no deja temporales ni la contraseña en logs', async () => {
    const tmpDb = path.join((await import('node:os')).tmpdir(), `kpi-${process.pid}-${Date.now()}.db`);
    makeSqliteDb(tmpDb, 100).close();
    const h = await makeHarness({ databases: MYSQL_AND_SQLITE(tmpDb) });
    try {
      h.mysql.schemas = ['mysql', 'sys', 'calidad_mbc', 'diseno', 'nueva_base'].map((n) => schema(n));
      const rec = await runBackup(h.ctx, { type: 'SCHEDULED' });
      assert.equal(rec.status, 'success', JSON.stringify(rec.errors));
      assert.deepEqual(rec.discovered.mysql[0]!.schemas, ['calidad_mbc', 'diseno', 'nueva_base']);
      assert.equal(rec.results.filter((r) => r.status === 'success').length, 4);

      const root = h.cfg.paths.backupRoot;
      const files = await listFilesRecursive(root);
      assert.ok(files.every((f) => !f.endsWith('.partial')), 'sin .partial tras publicar');
      const gz = files.filter((f) => /\.(sql|sqlite)\.gz$/.test(f));
      assert.equal(gz.length, 4);
      // estructura <root>/<engine>/<id>/<año>/<mes>/<fecha>_<hora>.<ext>.gz
      assert.ok(gz.some((f) => /mysql[\\/]calidad_mbc[\\/]2026[\\/]11[\\/]2026-11-24_100000\.sql\.gz$/.test(f)), gz.join('\n'));
      assert.ok(gz.some((f) => /sqlite[\\/]kpis[\\/]2026[\\/]11[\\/]2026-11-24_100000\.sqlite\.gz$/.test(f)));
      // manifiesto
      const m = JSON.parse(await fs.readFile(gz.find((f) => f.endsWith('.sqlite.gz'))! + MANIFEST_SUFFIX, 'utf8')) as Manifest;
      assert.equal(m.engine, 'sqlite');
      assert.equal(m.databaseId, 'kpis');
      assert.equal(m.runType, 'SCHEDULED');
      assert.equal(m.validation.result, 'ok');
      assert.match(m.sha256, /^[0-9a-f]{64}$/);
      assert.equal(m.tool.name, 'sqlite3');
      assert.ok(m.sizeBytes > 0 && m.fileName.endsWith('.sqlite.gz') && m.startedAt && m.finishedAt && m.status === 'success');
      // verificación posterior desde disco
      const items = await verifyBackups(h.ctx, { deep: true });
      assert.equal(items.length, 4);
      assert.ok(items.every((i) => i.ok), JSON.stringify(items));
      // secuencial: nunca dos operaciones externas simultáneas
      assert.equal(h.runner.maxActive, 1);
      // la contraseña no aparece en logs, estado ni registros
      const everything = h.logLines.join('\n') + (await fs.readFile(h.cfg.paths.stateFile, 'utf8'));
      assert.ok(!everything.includes(TEST_PASSWORD));
      assert.ok(!h.runner.runCalls.some((c) => c.args.join(' ').includes(TEST_PASSWORD)));
      // estado persistente
      const st = await h.ctx.state.read();
      assert.equal(st.lastRun?.status, 'success');
      assert.ok(st.lastCompletedAt);
      assert.equal(st.currentRun, undefined);
      // lock liberado
      await assert.rejects(fs.stat(h.cfg.paths.lockFile));
    } finally {
      await h.cleanup();
      await fs.rm(tmpDb, { force: true });
    }
  });

  it('un fallo individual no detiene las demás bases y conserva los respaldos anteriores (#12, #13)', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = ['a_ok', 'b_falla', 'c_incompleta', 'd_ok'].map((n) => schema(n));
      const root = h.cfg.paths.backupRoot;
      const prevB = await createFakeBackup(root, mysqlTarget('b_falla'), new Date('2026-11-23T23:59:00-06:00'));
      const prevC = await createFakeBackup(root, mysqlTarget('c_incompleta'), new Date('2026-11-23T23:59:00-06:00'));
      h.runner.failDumpSchemas.add('b_falla');
      h.runner.incompleteDumpSchemas.add('c_incompleta');
      const rec = await runBackup(h.ctx, { type: 'SCHEDULED' });
      assert.equal(rec.status, 'partial');
      const by = Object.fromEntries(rec.results.map((r) => [r.databaseId, r]));
      assert.equal(by.a_ok!.status, 'success');
      assert.equal(by.b_falla!.status, 'failed');
      assert.equal(by.c_incompleta!.status, 'failed');
      assert.equal(by.d_ok!.status, 'success');
      assert.ok(!by.b_falla!.error!.includes(TEST_PASSWORD));
      // respaldos anteriores intactos y sin archivos de la ejecución fallida
      assert.ok(await fs.stat(prevB));
      assert.ok(await fs.stat(prevC));
      const files = await listFilesRecursive(root);
      assert.ok(files.every((f) => !f.endsWith('.partial')));
      assert.equal((await listBackups(root, mysqlTarget('b_falla'))).length, 1);
      assert.equal((await listBackups(root, mysqlTarget('d_ok'))).length, 1);
      // la retención NO se aplica a bases fallidas
      assert.ok(!h.logLines.some((l) => l.includes('Retención aplicada') && l.includes('b_falla')));
      const st = await h.ctx.state.read();
      assert.equal(st.lastRun?.status, 'partial');
      assert.ok(st.lastCompletedAt);
    } finally {
      await h.cleanup();
    }
  });

  it('error de conexión a una instancia MySQL no impide respaldar SQLite (#3)', async () => {
    const dbFile = path.join((await import('node:os')).tmpdir(), `k2-${process.pid}-${Date.now()}.db`);
    makeSqliteDb(dbFile, 10).close();
    const h = await makeHarness({ databases: MYSQL_AND_SQLITE(dbFile) });
    try {
      h.mysql.failInstances.add('principal');
      const rec = await runBackup(h.ctx, { type: 'SCHEDULED' });
      assert.equal(rec.status, 'partial');
      assert.ok(rec.errors.some((e) => /ECONNREFUSED/.test(e)));
      assert.equal(rec.results.filter((r) => r.status === 'success').length, 1);
    } finally {
      await h.cleanup();
      await fs.rm(dbFile, { force: true });
    }
  });

  it('SQLite inexistente o corrupta falla de forma aislada; la ejecución continúa', async () => {
    const ok = path.join((await import('node:os')).tmpdir(), `k3-${process.pid}-${Date.now()}.db`);
    makeSqliteDb(ok, 10).close();
    const h = await makeHarness({
      databases: {
        sqlite: [
          { id: 'fantasma', path: path.join(ok, '..', 'no-existe-xyz.db') },
          { id: 'buena', path: ok },
          { id: 'apagada', path: path.join(ok, '..', 'otra.db'), enabled: false },
        ],
      },
    });
    try {
      const rec = await runBackup(h.ctx, { type: 'MANUAL' });
      assert.equal(rec.status, 'partial');
      assert.equal(rec.results.length, 2, 'las deshabilitadas no se procesan');
      assert.equal(rec.results.find((r) => r.databaseId === 'fantasma')!.status, 'failed');
      assert.equal(rec.results.find((r) => r.databaseId === 'buena')!.status, 'success');
      assert.match((await listFilesRecursive(h.cfg.paths.backupRoot)).find((f) => f.endsWith('.sqlite.gz'))!, /_MANUAL\.sqlite\.gz$/);
    } finally {
      await h.cleanup();
      await fs.rm(ok, { force: true });
    }
  });

  it('herramienta ausente: la otra base de datos igualmente se respalda', async () => {
    const dbFile = path.join((await import('node:os')).tmpdir(), `k4-${process.pid}-${Date.now()}.db`);
    makeSqliteDb(dbFile, 10).close();
    const h = await makeHarness({ databases: MYSQL_AND_SQLITE(dbFile) });
    try {
      h.mysql.schemas = [schema('x')];
      h.runner.missingTools.add('mysqldump-fake');
      const rec = await runBackup(h.ctx, { type: 'SCHEDULED' });
      assert.equal(rec.status, 'partial');
      assert.ok(rec.errors.some((e) => /mysqldump/.test(e)));
      assert.equal(rec.results.find((r) => r.databaseId === 'kpis')!.status, 'success');
    } finally {
      await h.cleanup();
      await fs.rm(dbFile, { force: true });
    }
  });

  it('aplica la retención de 15 tras publicar un nuevo respaldo (misma base)', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('calidad_mbc'), schema('diseno')];
      const root = h.cfg.paths.backupRoot;
      for (let i = 0; i < 24; i++) await createFakeBackup(root, mysqlTarget('calidad_mbc'), new Date(Date.UTC(2026, 9, 1 + i, 5, 59)));
      for (let i = 0; i < 5; i++) await createFakeBackup(root, mysqlTarget('diseno'), new Date(Date.UTC(2026, 9, 1 + i, 5, 59)));
      const rec = await runBackup(h.ctx, { type: 'SCHEDULED' });
      assert.equal(rec.status, 'success');
      const cal = (await listBackups(root, mysqlTarget('calidad_mbc'))).filter((b) => b.valid);
      assert.equal(cal.length, 15);
      assert.equal(rec.results.find((r) => r.databaseId === 'calidad_mbc')!.retention!.deleted.length, 10);
      assert.equal((await listBackups(root, mysqlTarget('diseno'))).length, 6);
      // el respaldo recién creado sigue presente
      assert.ok(cal.some((b) => b.manifest.runId === rec.runId));
    } finally {
      await h.cleanup();
    }
  });

  it('nombres de esquema hostiles no pueden escapar del directorio autorizado (#18)', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('..\\..\\evil'), schema('../../evil2'), schema('con'), schema('norm')];
      const rec = await runBackup(h.ctx, { type: 'SCHEDULED' });
      assert.equal(rec.status, 'success', JSON.stringify(rec));
      const all = await listFilesRecursive(h.tmp);
      const root = h.cfg.paths.backupRoot;
      for (const f of all.filter((x) => x.endsWith('.sql.gz'))) {
        assert.ok(path.relative(root, f).split(path.sep)[0] === 'mysql' && !path.relative(root, f).startsWith('..'), f);
      }
      assert.ok(!all.some((f) => f.includes('evil') && !f.startsWith(root)));
    } finally {
      await h.cleanup();
    }
  });
});

describe('Salvaguardas', () => {
  it('modo development sin MBC_ALLOW_LIVE bloquea cualquier acceso real (dry-run y run)', async () => {
    const h = await makeHarness({ env: { MBC_MODE: 'development', MBC_ALLOW_LIVE: 'false' } });
    try {
      h.mysql.schemas = [schema('x')];
      for (const dryRun of [true, false]) {
        await assert.rejects(runBackup(h.ctx, { type: 'MANUAL', dryRun }), (e) => e instanceof BackupError && e.code === 'LIVE_BLOCKED');
      }
      assert.equal(h.runner.runCalls.length + h.runner.streamCalls.length, 0, 'no se ejecutó ninguna herramienta');
      await assert.rejects(fs.stat(h.cfg.paths.backupRoot));
    } finally {
      await h.cleanup();
    }
  });

  it('dry-run no escribe respaldos, ni bloqueo, ni estado', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('a'), schema('sys'), schema('b')];
      const rec = await runBackup(h.ctx, { type: 'MANUAL', dryRun: true });
      assert.equal(rec.status, 'success');
      assert.deepEqual(rec.results.map((r) => r.databaseId), ['a', 'b']);
      assert.ok(rec.results.every((r) => r.status === 'skipped'));
      assert.equal(h.runner.streamCalls.length, 0);
      assert.deepEqual(await listFilesRecursive(h.cfg.paths.backupRoot), []);
      await assert.rejects(fs.stat(h.cfg.paths.stateFile));
    } finally {
      await h.cleanup();
    }
  });

  it('espacio insuficiente: detiene la ejecución, no genera ni elimina nada (#16)', async () => {
    const h = await makeHarness({ env: { MIN_FREE_GB: '10' }, free: 5 * 1024 ** 3 });
    try {
      h.mysql.schemas = [schema('calidad_mbc')];
      const root = h.cfg.paths.backupRoot;
      const old: string[] = [];
      for (let i = 0; i < 20; i++) old.push(await createFakeBackup(root, mysqlTarget('calidad_mbc'), new Date(Date.UTC(2026, 9, 1 + i, 5, 59))));
      const before = await listFilesRecursive(root);
      const rec = await runBackup(h.ctx, { type: 'SCHEDULED' });
      assert.equal(rec.status, 'aborted');
      assert.match(rec.errors.join(' '), /Espacio insuficiente/);
      assert.deepEqual(await listFilesRecursive(root), before, 'no se eliminó ni creó ningún archivo');
      assert.equal(h.runner.streamCalls.length, 0);
      assert.equal((await h.ctx.state.read()).lastCompletedAt, undefined);
    } finally {
      await h.cleanup();
    }
  });

  it('espacio insuficiente para una base grande: se detiene el resto sin eliminar respaldos', async () => {
    let free = 100 * 1024 ** 3;
    const h = await makeHarness({ env: { MIN_FREE_GB: '10' } });
    h.ctx.freeBytes = async () => free;
    try {
      h.mysql.schemas = [schema('pequena'), schema('enorme', { estimatedBytes: 400 * 1024 ** 3 }), schema('despues')];
      const rec = await runBackup(h.ctx, { type: 'SCHEDULED' });
      assert.equal(rec.status, 'aborted');
      const by = Object.fromEntries(rec.results.map((r) => [r.databaseId, r.status]));
      assert.deepEqual(by, { pequena: 'success', enorme: 'failed', despues: 'skipped' });
      free = 0;
    } finally {
      await h.cleanup();
    }
  });

  it('el archivo definitivo nunca se sobrescribe (misma marca de tiempo -> sufijo)', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('calidad_mbc')];
      const r1 = await runBackup(h.ctx, { type: 'SCHEDULED' });
      const r2 = await runBackup(h.ctx, { type: 'SCHEDULED' }); // mismo reloj fijo
      assert.equal(r1.status, 'success');
      assert.equal(r2.status, 'success');
      const files = (await listFilesRecursive(h.cfg.paths.backupRoot)).filter((f) => f.endsWith('.sql.gz')).map((f) => path.basename(f));
      assert.deepEqual(files, ['2026-11-24_100000-2.sql.gz', '2026-11-24_100000.sql.gz']);
    } finally {
      await h.cleanup();
    }
  });

  it('verify detecta un respaldo alterado', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('calidad_mbc')];
      await runBackup(h.ctx, { type: 'SCHEDULED' });
      const gz = (await listFilesRecursive(h.cfg.paths.backupRoot)).find((f) => f.endsWith('.sql.gz'))!;
      const buf = await fs.readFile(gz);
      buf[Math.floor(buf.length / 2)]! ^= 0x55;
      await fs.writeFile(gz, buf);
      const items = await verifyBackups(h.ctx, {});
      assert.equal(items[0]!.ok, false);
    } finally {
      await h.cleanup();
    }
  });

  it('apunta a sqliteTarget helper sin errores de tipos', () => {
    assert.equal(sqliteTarget('x').engine, 'sqlite');
  });
});
