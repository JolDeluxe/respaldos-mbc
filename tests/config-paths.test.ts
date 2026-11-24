import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assertNodeVersion, isSupportedNode, parseDatabases, parseEnv, readDatabasesFile } from '../src/config/load.js';
import { selectSchemas } from '../src/discovery/mysql.js';
import { BackupError } from '../src/util/errors.js';
import { resolveInside, safeSegment, atomicWriteJson } from '../src/util/fsx.js';
import { makeTmp, schema } from './helpers/harness.js';

const baseEnv = { BACKUP_ROOT: 'C:\\Servidor\\BasesDatos\\Respaldos\\Diarios' };

describe('Rutas seguras (#18)', () => {
  it('codifica nombres peligrosos sin separadores ni ".."', () => {
    for (const bad of ['..', '../../etc', 'a/b', 'a\\b', 'C:\\x', 'con', 'NUL', 'db name', 'a.b', 'ñandú']) {
      const seg = safeSegment(bad);
      assert.match(seg, /^[A-Za-z0-9_~-]+$/, bad);
      assert.ok(!seg.includes('..') && !/[\\/]/.test(seg));
    }
  });
  it('es inyectiva (nombres distintos -> segmentos distintos)', () => {
    const names = ['a.b', 'a_b', 'a~2eb', 'A.B', 'con', '~63on'];
    assert.equal(new Set(names.map(safeSegment)).size, names.length);
  });
  it('resolveInside rechaza escapes del directorio autorizado', () => {
    const root = path.resolve('/tmp/root-aut');
    assert.throws(() => resolveInside(root, '..', 'x'), (e) => e instanceof BackupError && e.code === 'PATH_ESCAPE');
    assert.throws(() => resolveInside(root, 'a/../../b'), /no permitido/);
    assert.throws(() => resolveInside(root, 'a\\b'), /no permitido/);
    assert.throws(() => resolveInside(root, 'C:'), /no permitido/);
    assert.throws(() => resolveInside(root), /fuera del directorio/);
    assert.ok(resolveInside(root, 'mysql', safeSegment('../../evil')).startsWith(root));
  });
});

describe('Configuración (#17, #20)', () => {
  it('acepta el ejemplo versionado', async () => {
    const cfg = readDatabasesFile(path.resolve('config/databases.example.json'));
    assert.equal(cfg.mysql[0]?.autoDiscover, true);
    assert.equal(cfg.sqlite[0]?.id, 'kpis');
  });
  it('valores por defecto: 23:59 México, retención 15, programador apagado, modo development, BACKUP_ROOT .local-backups', () => {
    const env = parseEnv({} as NodeJS.ProcessEnv);
    assert.equal(env.CRON_EXPRESSION, '59 23 * * *');
    assert.equal(env.TIMEZONE, 'America/Mexico_City');
    assert.equal(env.RETENTION_COUNT, 15);
    assert.equal(env.ENABLE_SCHEDULER, false);
    assert.equal(env.MBC_MODE, 'development');
    assert.equal(env.MBC_ALLOW_LIVE, false);
    assert.equal(env.BACKUP_ROOT, '.local-backups');
  });
  const invalidEnvs: Array<[string, Record<string, string>]> = [
    ['BACKUP_ROOT vacía', { BACKUP_ROOT: '' }],
    ['cron inválido', { ...baseEnv, CRON_EXPRESSION: '99 99 * * *' }],
    ['zona inválida', { ...baseEnv, TIMEZONE: 'Marte/Olimpo' }],
    ['modo inválido', { ...baseEnv, MBC_MODE: 'staging' }],
    ['retención 0', { ...baseEnv, RETENTION_COUNT: '0' }],
    ['número inválido', { ...baseEnv, MIN_FREE_GB: 'abc' }],
  ];
  for (const [name, env] of invalidEnvs) {
    it(`rechaza entorno: ${name}`, () => {
      assert.throws(() => parseEnv(env as NodeJS.ProcessEnv), (e) => e instanceof BackupError && e.code === 'CONFIG_INVALID');
    });
  }
  const invalidDbs: Array<[string, unknown]> = [
    ['SQLite con ruta relativa', { sqlite: [{ id: 'a', path: 'rel/a.db' }] }],
    ['id con caracteres peligrosos', { sqlite: [{ id: '../x', path: 'C:\\a.db' }] }],
    ['ids SQLite duplicados', { sqlite: [{ id: 'a', path: 'C:\\a.db' }, { id: 'A', path: 'C:\\b.db' }] }],
    ['ids MySQL duplicados', { mysql: [{ id: 'm', host: 'h', user: 'u', passwordEnv: 'P' }, { id: 'm', host: 'h', user: 'u', passwordEnv: 'P', namespaced: true }] }],
    ['dos instancias con diseño plano', { mysql: [{ id: 'm1', host: 'h', user: 'u', passwordEnv: 'P' }, { id: 'm2', host: 'h', user: 'u', passwordEnv: 'P' }] }],
    ['sin passwordEnv', { mysql: [{ id: 'm', host: 'h', user: 'u' }] }],
    ['passwordEnv inválido', { mysql: [{ id: 'm', host: 'h', user: 'u', passwordEnv: 'a b;c' }] }],
    ['autoDiscover=false sin includeSchemas', { mysql: [{ id: 'm', host: 'h', user: 'u', passwordEnv: 'P', autoDiscover: false }] }],
    ['puerto fuera de rango', { mysql: [{ id: 'm', host: 'h', user: 'u', passwordEnv: 'P', port: 70000 }] }],
  ];
  for (const [name, raw] of invalidDbs) {
    it(`rechaza databases.json: ${name}`, () => {
      assert.throws(() => parseDatabases(raw), (e) => e instanceof BackupError && e.code === 'CONFIG_INVALID');
    });
  }
  it('múltiples instancias: una plana + una namespaced es válido', () => {
    parseDatabases({
      mysql: [
        { id: 'm1', host: 'h', user: 'u', passwordEnv: 'P' },
        { id: 'm2', host: 'h2', user: 'u', passwordEnv: 'P2', namespaced: true },
      ],
    });
  });
  it('archivo inexistente o JSON corrupto -> CONFIG_INVALID con ayuda', async () => {
    const tmp = await makeTmp();
    assert.throws(() => readDatabasesFile(path.join(tmp, 'nada.json')), /databases\.example\.json/);
    await fs.writeFile(path.join(tmp, 'x.json'), '{ no json');
    assert.throws(() => readDatabasesFile(path.join(tmp, 'x.json')), /no es JSON válido/);
    await atomicWriteJson(path.join(tmp, 'ok.json'), { sqlite: [] });
    assert.deepEqual(readDatabasesFile(path.join(tmp, 'ok.json')).sqlite, []);
    await fs.rm(tmp, { recursive: true, force: true });
  });
  it('versión de Node: 22.18+ y 26+ soportadas; otras no', () => {
    for (const v of ['22.18.0', '22.23.4', '22.99.1', '26.0.0', '26.3.1', '28.0.0']) assert.ok(isSupportedNode(v), v);
    for (const v of ['22.17.9', '22.0.0', '20.19.0', '23.5.0', '24.1.0', '25.0.0']) assert.ok(!isSupportedNode(v), v);
    assert.throws(() => assertNodeVersion('20.0.0'), (e) => e instanceof BackupError && e.code === 'NODE_VERSION');
    assertNodeVersion(); // la versión actual debe estar soportada
  });
});

describe('Descubrimiento MySQL: selección de esquemas (#1, #2)', () => {
  const all = ['mysql', 'information_schema', 'performance_schema', 'sys', 'calidad_mbc', 'diseno', 'mantenimiento', 'gestor_calidad_prod', 'avance_material', 'encuestas_5s', 'nueva_futura'].map((n) => schema(n));
  const inst = parseDatabases({ mysql: [{ id: 'p', host: 'h', user: 'u', passwordEnv: 'P' }] }).mysql[0]!;

  it('excluye esquemas internos y respalda todos los demás, incluidos los nuevos', () => {
    const sel = selectSchemas(all, inst);
    assert.deepEqual(sel.selected.map((s) => s.name), ['calidad_mbc', 'diseno', 'mantenimiento', 'gestor_calidad_prod', 'avance_material', 'encuestas_5s', 'nueva_futura']);
    assert.deepEqual(sel.skipped.map((s) => s.name), ['mysql', 'information_schema', 'performance_schema', 'sys']);
  });
  it('los esquemas del sistema se excluyen aunque el usuario los incluya o varíe mayúsculas', () => {
    const i2 = parseDatabases({ mysql: [{ id: 'p', host: 'h', user: 'u', passwordEnv: 'P', autoDiscover: false, includeSchemas: ['MySQL', 'diseno'] }] }).mysql[0]!;
    const sel = selectSchemas([...all, schema('MySQL')], i2);
    assert.deepEqual(sel.selected.map((s) => s.name), ['diseno']);
  });
  it('excludeSchemas configurable y avisa de esquemas incluidos que no existen', () => {
    const i3 = parseDatabases({ mysql: [{ id: 'p', host: 'h', user: 'u', passwordEnv: 'P', excludeSchemas: ['kpis_test', 'DISENO'] }] }).mysql[0]!;
    assert.ok(!selectSchemas(all, i3).selected.some((s) => s.name === 'diseno'));
    const i4 = parseDatabases({ mysql: [{ id: 'p', host: 'h', user: 'u', passwordEnv: 'P', autoDiscover: false, includeSchemas: ['no_existe'] }] }).mysql[0]!;
    assert.deepEqual(selectSchemas(all, i4).missing, ['no_existe']);
  });
});
