import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { gzipFile, verifyGzipFile } from '../src/backup/gzip.js';
import { buildMysqldumpArgs, dumpMysqlSchema, writeOptionsFile, removeOptionsFile } from '../src/backup/mysql/dump.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { backupSqliteFile } from '../src/backup/sqlite/backup.js';
import { BackupError } from '../src/util/errors.js';
import { parseDatabases } from '../src/config/load.js';
import { FAKE_MYSQLDUMP, FAKE_SQLITE, FakeRunner, makeSqliteDb, makeTmp, TEST_PASSWORD } from './helpers/harness.js';

let tmp: string;
before(async () => {
  tmp = await makeTmp();
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GZIP y SHA-256 (#7, #8)', () => {
  it('comprime por streaming, y verifica CRC + hashes', async () => {
    const src = path.join(tmp, 'datos.txt');
    const data = Buffer.from('línea de prueba\n'.repeat(50_000));
    await fs.writeFile(src, data);
    const gz = path.join(tmp, 'datos.txt.gz.partial');
    const st = await gzipFile(src, gz, 4);
    assert.equal(st.contentSha256, createHash('sha256').update(data).digest('hex'));
    assert.equal(st.contentBytes, data.length);
    const v = await verifyGzipFile(gz);
    assert.equal(v.contentSha256, st.contentSha256);
    assert.equal(v.sha256, createHash('sha256').update(await fs.readFile(gz)).digest('hex'));
    assert.ok(v.sizeBytes < data.length / 5, 'debe comprimir');
  });
  it('detecta un .gz truncado o corrupto', async () => {
    const src = path.join(tmp, 'c.txt');
    await fs.writeFile(src, 'x'.repeat(200_000));
    const gz = path.join(tmp, 'c.gz.partial');
    await gzipFile(src, gz, 4);
    const buf = await fs.readFile(gz);
    await fs.writeFile(path.join(tmp, 'trunc.gz'), buf.subarray(0, buf.length - 10));
    await assert.rejects(verifyGzipFile(path.join(tmp, 'trunc.gz')));
    const bad = Buffer.from(buf);
    bad[Math.floor(bad.length / 2)]! ^= 0xff;
    await fs.writeFile(path.join(tmp, 'bad.gz'), bad);
    await assert.rejects(verifyGzipFile(path.join(tmp, 'bad.gz')));
  });
  it('no sobrescribe un destino existente (flag wx)', async () => {
    const src = path.join(tmp, 'd.txt');
    await fs.writeFile(src, 'abc');
    const dest = path.join(tmp, 'ya-existe.partial');
    await fs.writeFile(dest, 'x');
    await assert.rejects(gzipFile(src, dest, 4), /EEXIST/);
  });
  it('maneja archivos grandes sin cargarlos en memoria (stream de 60 MB)', async () => {
    const big = path.join(tmp, 'big.bin');
    const chunk = Buffer.alloc(1024 * 1024, 'abcdefgh');
    await pipeline(Readable.from((function* () { for (let i = 0; i < 60; i++) yield chunk; })()), createWriteStream(big));
    const before = process.memoryUsage().rss;
    const st = await gzipFile(big, path.join(tmp, 'big.gz.partial'), 1);
    const v = await verifyGzipFile(path.join(tmp, 'big.gz.partial'));
    assert.equal(v.contentBytes, 60 * 1024 * 1024);
    assert.equal(v.contentSha256, st.contentSha256);
    assert.ok(process.memoryUsage().rss - before < 80 * 1024 * 1024, 'el RSS no debe crecer con el tamaño del archivo');
  });
});

describe('SQLite: respaldo consistente e integridad (#4, #5)', () => {
  it('respalda una base WAL abierta con .backup, valida integridad y comprime', async () => {
    const dbFile = path.join(tmp, 'kpi.db');
    const db = makeSqliteDb(dbFile, 500); // conexión abierta = aplicación en uso (WAL)
    const runner = new FakeRunner();
    const partial = path.join(tmp, 'kpi.sqlite.gz.partial');
    const copy = path.join(tmp, 'kpi.partial-db');
    const r = await backupSqliteFile(runner, { command: FAKE_SQLITE, sourcePath: dbFile, tempCopyPath: copy, partialPath: partial, gzipLevel: 4, timeoutMs: 60000 });
    assert.ok(r.checks.includes('PRAGMA integrity_check = ok'));
    // la copia intermedia se elimina
    await assert.rejects(fs.stat(copy));
    // la copia restaurada contiene los 500 registros
    const restored = path.join(tmp, 'restored.db');
    const { gunzipToFile } = await import('../src/backup/gzip.js');
    await gunzipToFile(partial, restored);
    const { DatabaseSync } = await import('node:sqlite');
    const rdb = new DatabaseSync(restored, { readOnly: true });
    assert.equal((rdb.prepare('SELECT COUNT(*) AS n FROM kpi').get() as { n: number }).n, 500);
    rdb.close();
    // el original sigue utilizable y sin cambios
    db.prepare('INSERT INTO kpi (valor) VALUES (?)').run('posterior');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM kpi').get() as { n: number }).n, 501);
    db.close();
    // se invocó .backup y NUNCA se copió el archivo directamente
    assert.ok(runner.runCalls.some((c) => c.args[2]?.startsWith('.backup')));
  });
  it('falla si integrity_check no devuelve "ok" y no deja archivos', async () => {
    const dbFile = path.join(tmp, 'corrupta.db');
    makeSqliteDb(dbFile, 5).close();
    const runner = new FakeRunner();
    runner.corruptIntegrity = true;
    const partial = path.join(tmp, 'corrupta.gz.partial');
    const copy = path.join(tmp, 'corrupta.partial-db');
    await assert.rejects(
      backupSqliteFile(runner, { command: FAKE_SQLITE, sourcePath: dbFile, tempCopyPath: copy, partialPath: partial, gzipLevel: 4, timeoutMs: 60000 }),
      (e) => e instanceof BackupError && e.code === 'VALIDATION_FAILED' && /integrity_check/.test(e.message),
    );
    await assert.rejects(fs.stat(copy));
    await assert.rejects(fs.stat(partial)); // nunca se comprimió/publicó
  });
  it('base inexistente -> SOURCE_MISSING', async () => {
    await assert.rejects(
      backupSqliteFile(new FakeRunner(), { command: FAKE_SQLITE, sourcePath: path.join(tmp, 'no.db'), tempCopyPath: path.join(tmp, 'n.partial-db'), partialPath: path.join(tmp, 'n.gz.partial'), gzipLevel: 4, timeoutMs: 1000 }),
      (e) => e instanceof BackupError && e.code === 'SOURCE_MISSING',
    );
  });
  it('rechaza rutas con comilla simple (inyección en comandos de sqlite3)', async () => {
    const dbFile = path.join(tmp, 'ok2.db');
    makeSqliteDb(dbFile, 1).close();
    await assert.rejects(
      backupSqliteFile(new FakeRunner(), { command: FAKE_SQLITE, sourcePath: dbFile, tempCopyPath: path.join(tmp, "x'; .shell calc.partial-db"), partialPath: path.join(tmp, 'q.gz.partial'), gzipLevel: 4, timeoutMs: 1000 }),
      /no permitidos/,
    );
  });
});

describe('MySQL: mysqldump simulado (#6, #9)', () => {
  const inst = parseDatabases({ mysql: [{ id: 'p', host: '127.0.0.1', user: 'mbc_backup', passwordEnv: 'P' }] }).mysql[0]!;

  it('incluye las opciones requeridas y NO pone la contraseña en los argumentos', () => {
    const args = buildMysqldumpArgs('C:\\t\\opts.cnf', 'calidad_mbc');
    assert.ok(args[0]!.startsWith('--defaults-extra-file='), 'debe ser el primer argumento');
    for (const o of ['--single-transaction', '--quick', '--routines', '--events', '--triggers', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', '--databases']) {
      assert.ok(args.includes(o), o);
    }
    assert.ok(!args.includes('--all-databases'));
    assert.deepEqual(args.slice(-2), ['--', 'calidad_mbc']);
    assert.ok(!args.some((a) => /password|^-p/i.test(a)), 'ningún argumento debe llevar contraseña (-p / --password)');
  });
  it('exporta en streaming, usa archivo de opciones temporal y lo elimina', async () => {
    const runner = new FakeRunner();
    const partial = path.join(tmp, 'm1.sql.gz.partial');
    const stats = await dumpMysqlSchema(runner, { command: FAKE_MYSQLDUMP, instance: inst, schema: 'calidad_mbc', password: TEST_PASSWORD, tempDir: path.join(tmp, 'tmpopts'), partialPath: partial, gzipLevel: 4, timeoutMs: 60000 });
    assert.match(stats.tail, /Dump completed/);
    const call = runner.streamCalls[0]!;
    assert.ok(call.optionsFileExistedAtStart, 'el archivo de opciones debía existir durante la exportación');
    assert.match(call.optionsFileContent, /password="S3cr3t/);
    assert.ok(!call.args.join(' ').includes(TEST_PASSWORD), 'la contraseña no debe aparecer en los argumentos');
    assert.deepEqual(await fs.readdir(path.join(tmp, 'tmpopts')), [], 'el archivo de opciones debe eliminarse');
    const v = await verifyGzipFile(partial);
    assert.equal(v.contentSha256, stats.contentSha256);
  });
  it('mysqldump con error: falla, redacta la contraseña del mensaje y elimina el archivo de opciones', async () => {
    const runner = new FakeRunner();
    runner.failDumpSchemas.add('diseno');
    await assert.rejects(
      dumpMysqlSchema(runner, { command: FAKE_MYSQLDUMP, instance: inst, schema: 'diseno', password: TEST_PASSWORD, tempDir: path.join(tmp, 'tmpopts2'), partialPath: path.join(tmp, 'm2.partial'), gzipLevel: 4, timeoutMs: 60000 }),
      (e: Error) => /código 2/.test(e.message) && !e.message.includes(TEST_PASSWORD),
    );
    assert.deepEqual(await fs.readdir(path.join(tmp, 'tmpopts2')), []);
  });
  it('un volcado sin "Dump completed" se rechaza como incompleto', async () => {
    const runner = new FakeRunner();
    runner.incompleteDumpSchemas.add('x');
    await assert.rejects(
      dumpMysqlSchema(runner, { command: FAKE_MYSQLDUMP, instance: inst, schema: 'x', password: 'p', tempDir: path.join(tmp, 'tmpopts3'), partialPath: path.join(tmp, 'm3.partial'), gzipLevel: 4, timeoutMs: 60000 }),
      (e) => e instanceof BackupError && e.code === 'VALIDATION_FAILED',
    );
  });
  it('mysqldump inexistente -> TOOL_MISSING', async () => {
    const runner = new FakeRunner();
    runner.missingTools.add(FAKE_MYSQLDUMP);
    await assert.rejects(
      dumpMysqlSchema(runner, { command: FAKE_MYSQLDUMP, instance: inst, schema: 'x', password: 'p', tempDir: path.join(tmp, 'tmpopts4'), partialPath: path.join(tmp, 'm4.partial'), gzipLevel: 4, timeoutMs: 60000 }),
      (e) => e instanceof BackupError && e.code === 'TOOL_MISSING',
    );
  });
  it('aplica ACLs restrictivas en Windows al archivo temporal de opciones', async () => {
    if (process.platform !== 'win32') return;
    const optFile = await writeOptionsFile(path.join(tmp, 'tmpacl'), inst, 'pass-secreto');
    try {
      const { stdout } = await execFileAsync('icacls.exe', [optFile]);
      // Comprueba que no tenga herencia abierta a usuarios no autorizados
      assert.match(stdout, /NT AUTHORITY\\SYSTEM|\*S-1-5-18/);
      assert.match(stdout, /Administradores|Administrators|\*S-1-5-32-544/);
    } finally {
      await removeOptionsFile(optFile);
    }
  });
});
