import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { applyRetention } from '../src/retention/retention.js';
import { listBackups, targetDir } from '../src/storage/layout.js';
import { createFakeBackup, listFilesRecursive, mysqlTarget, sqliteTarget } from './helpers/fixtures.js';
import { makeHarness } from './helpers/harness.js';

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n, 5, 59, 0)); // n días desde 2026-10-01

describe('Retención independiente de 15 respaldos (#11)', () => {
  it('con 24 respaldos conserva el más reciente y 14 más; elimina los 9 más antiguos solo de ESA base', async () => {
    const h = await makeHarness();
    try {
      const root = h.cfg.paths.backupRoot;
      const calidad = mysqlTarget('calidad_mbc');
      const diseno = mysqlTarget('diseno');
      const kpis = sqliteTarget('kpis');
      const created: Record<string, string[]> = { calidad: [], diseno: [], kpis: [] };
      for (let i = 0; i < 24; i++) created.calidad!.push(await createFakeBackup(root, calidad, day(i)));
      for (let i = 0; i < 20; i++) created.diseno!.push(await createFakeBackup(root, diseno, day(i)));
      for (let i = 0; i < 3; i++) created.kpis!.push(await createFakeBackup(root, kpis, day(i)));

      // Archivos ajenos en el mismo directorio de la base: NO deben tocarse.
      const dir = path.dirname(created.calidad![0]!);
      await fs.writeFile(path.join(dir, 'notas-de-otra-app.txt'), 'ajeno');
      await fs.writeFile(path.join(dir, 'otro.sql.gz'), 'ajeno sin formato');
      await fs.writeFile(path.join(root, 'sqlite', 'LEEME.txt').replace('LEEME', 'x'), 'x').catch(() => undefined);

      const before = await listFilesRecursive(root);
      const res = await applyRetention(h.ctx, calidad);
      assert.equal(res.deleted.length, 9);
      assert.equal(res.kept, 15);
      assert.deepEqual(res.errors, []);

      const left = (await listBackups(root, calidad)).filter((b) => b.valid);
      assert.equal(left.length, 15);
      // se conservan exactamente los 15 más recientes (días 9..23)
      const keptNames = new Set(left.map((b) => b.filePath));
      for (let i = 0; i < 24; i++) assert.equal(keptNames.has(created.calidad![i]!), i >= 9, `día ${i}`);
      // las 9 eliminadas perdieron también su manifiesto
      for (let i = 0; i < 9; i++) {
        await assert.rejects(fs.stat(created.calidad![i]! + '.manifest.json'));
      }
      // otras bases intactas
      const after = await listFilesRecursive(root);
      const removed = before.filter((f) => !after.includes(f));
      assert.equal(removed.length, 18, '9 archivos + 9 manifiestos, solo de calidad_mbc');
      assert.ok(removed.every((f) => f.startsWith(targetDir(root, calidad))));
      assert.equal((await listBackups(root, diseno)).length, 20);
      assert.equal((await listBackups(root, kpis)).length, 3);
      // archivos ajenos intactos
      assert.ok(after.includes(path.join(dir, 'notas-de-otra-app.txt')));
      assert.ok(after.includes(path.join(dir, 'otro.sql.gz')));
      // no se eliminaron directorios de año/mes
      const dirs = await fs.readdir(path.join(targetDir(root, calidad)));
      assert.ok(dirs.includes('2026'));
    } finally {
      await h.cleanup();
    }
  });

  it('no elimina nada si hay 15 o menos', async () => {
    const h = await makeHarness();
    try {
      const t = mysqlTarget('mantenimiento');
      for (let i = 0; i < 15; i++) await createFakeBackup(h.cfg.paths.backupRoot, t, day(i));
      const res = await applyRetention(h.ctx, t);
      assert.equal(res.deleted.length, 0);
      assert.equal((await listBackups(h.cfg.paths.backupRoot, t)).length, 15);
    } finally {
      await h.cleanup();
    }
  });

  it('los respaldos inválidos (archivo ausente/tamaño distinto) no cuentan como válidos ni desplazan a los válidos', async () => {
    const h = await makeHarness();
    try {
      const root = h.cfg.paths.backupRoot;
      const t = mysqlTarget('avance_material');
      const files: string[] = [];
      for (let i = 0; i < 16; i++) files.push(await createFakeBackup(root, t, day(i)));
      await fs.writeFile(files[15]!, 'corrupto distinto tamaño!!!'); // el más reciente queda inválido
      const res = await applyRetention(h.ctx, t);
      // 15 válidos (días 0..14): no se elimina ninguno aunque existan 16 manifiestos
      assert.equal(res.deleted.length, 0);
      assert.equal(res.kept, 15);
      assert.ok(await fs.stat(files[0]!));
    } finally {
      await h.cleanup();
    }
  });

  it('un manifiesto de OTRA base dentro del directorio no se considera ni se elimina', async () => {
    const h = await makeHarness();
    try {
      const root = h.cfg.paths.backupRoot;
      const a = mysqlTarget('encuestas_5s');
      const foreign = mysqlTarget('otra_cosa');
      for (let i = 0; i < 17; i++) await createFakeBackup(root, a, day(i));
      // copiar un respaldo de "otra_cosa" dentro del directorio de encuestas_5s
      const src = await createFakeBackup(root, foreign, day(0));
      const dirA = path.dirname((await listBackups(root, a))[0]!.filePath);
      await fs.copyFile(src, path.join(dirA, '2000-01-01_000000.sql.gz'));
      await fs.copyFile(src + '.manifest.json', path.join(dirA, '2000-01-01_000000.sql.gz.manifest.json'));
      await applyRetention(h.ctx, a);
      assert.ok(await fs.stat(path.join(dirA, '2000-01-01_000000.sql.gz')), 'archivo de otra base intacto');
      assert.equal((await listBackups(root, a)).length, 15);
    } finally {
      await h.cleanup();
    }
  });
});
