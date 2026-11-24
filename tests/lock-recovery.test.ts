import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runBackup } from '../src/backup/runner.js';
import { cleanOrphans, evaluateRecovery, reconcileInterruptedRun } from '../src/recovery/recovery.js';
import { BackupScheduler } from '../src/scheduler/scheduler.js';
import { listBackups, MANIFEST_SUFFIX } from '../src/storage/layout.js';
import { acquireLock, inspectLock } from '../src/storage/lock.js';
import { BackupError } from '../src/util/errors.js';
import { formatStamp, lastScheduledSlot, parseDailyCron, zonedParts, zonedTimeToUtc } from '../src/util/time.js';
import { createFakeBackup, listFilesRecursive, mysqlTarget } from './helpers/fixtures.js';
import { makeHarness, makeTmp, schema } from './helpers/harness.js';
import type { Manifest, ServiceState } from '../src/types.js';

const TZ = 'America/Mexico_City';
const CRON = '59 23 * * *';

describe('Bloqueo persistente (#14)', () => {
  it('de 5 intentos simultáneos solo uno obtiene el bloqueo', async () => {
    const tmp = await makeTmp();
    const file = path.join(tmp, 'x.lock');
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => acquireLock(file, { staleMs: 60_000 })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1);
    for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof BackupError && r.reason.code === 'LOCK_HELD');
    await (ok[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
    await assert.rejects(fs.stat(file));
    (await acquireLock(file, { staleMs: 60_000 })).release();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const writeLock = (file: string, pid: number, heartbeatAgoMs: number) =>
    fs.writeFile(file, JSON.stringify({ pid, token: 'viejo', hostname: 'h', startedAt: new Date().toISOString(), heartbeatAt: new Date(Date.now() - heartbeatAgoMs).toISOString() }));

  it('proceso vivo con latido reciente: NO se reclama', async () => {
    const tmp = await makeTmp();
    const file = path.join(tmp, 'x.lock');
    await writeLock(file, process.pid, 1000);
    await assert.rejects(acquireLock(file, { staleMs: 60_000 }), (e) => e instanceof BackupError && e.code === 'LOCK_HELD');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).token, 'viejo');
  });
  it('proceso inexistente: se reclama de forma segura', async () => {
    const tmp = await makeTmp();
    const file = path.join(tmp, 'x.lock');
    await writeLock(file, 2_000_000_000, 1000);
    const h = await acquireLock(file, { staleMs: 60_000 });
    assert.equal((await inspectLock(file, 60_000)).present, true);
    await h.release();
  });
  it('PID reutilizado/colgado (latido antiguo): se reclama', async () => {
    const tmp = await makeTmp();
    const file = path.join(tmp, 'x.lock');
    await writeLock(file, process.pid, 3_600_000);
    const h = await acquireLock(file, { staleMs: 60_000 });
    await h.release();
  });
  it('un bloqueo reclamado por otra instancia no es eliminado por la anterior', async () => {
    const tmp = await makeTmp();
    const file = path.join(tmp, 'x.lock');
    const a = await acquireLock(file, { staleMs: 60_000 });
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, token: 'otra', heartbeatAt: new Date().toISOString() }));
    await a.release();
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).token, 'otra');
  });
  it('dos runBackup simultáneos: el segundo se rechaza y no genera nada', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('calidad_mbc')];
      const [a, b] = await Promise.allSettled([runBackup(h.ctx, { type: 'SCHEDULED' }), runBackup(h.ctx, { type: 'MANUAL' })]);
      const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
      const rejected = [a, b].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0]!.reason as BackupError).code, 'LOCK_HELD');
      assert.equal((await listFilesRecursive(h.cfg.paths.backupRoot)).filter((f) => f.endsWith('.sql.gz')).length, 1);
    } finally {
      await h.cleanup();
    }
  });
  it('runBackup reclama un bloqueo abandonado (proceso muerto) y continúa', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('calidad_mbc')];
      await fs.mkdir(h.cfg.paths.stateDir, { recursive: true });
      await fs.writeFile(h.cfg.paths.lockFile, JSON.stringify({ pid: 2_000_000_000, token: 'muerto', heartbeatAt: new Date().toISOString(), startedAt: new Date().toISOString() }));
      const rec = await runBackup(h.ctx, { type: 'SCHEDULED' });
      assert.equal(rec.status, 'success');
    } finally {
      await h.cleanup();
    }
  });
});

describe('Zonas horarias y huecos programados', () => {
  it('23:59 de México = 05:59 UTC del día siguiente', () => {
    assert.equal(zonedTimeToUtc(2026, 11, 23, 23, 59, 0, TZ).toISOString(), '2026-11-24T05:59:00.000Z');
    assert.equal(zonedTimeToUtc(2026, 7, 1, 23, 59, 0, 'America/New_York').toISOString(), '2026-07-02T03:59:00.000Z');
    assert.equal(zonedTimeToUtc(2026, 1, 1, 23, 59, 0, 'America/New_York').toISOString(), '2026-01-02T04:59:00.000Z');
  });
  it('último hueco programado respecto de "ahora"', () => {
    const daily = parseDailyCron(CRON)!;
    assert.deepEqual(daily, { minute: 59, hour: 23 });
    assert.equal(lastScheduledSlot(new Date('2026-11-24T10:00:00-06:00'), TZ, daily).toISOString(), '2026-11-24T05:59:00.000Z');
    assert.equal(lastScheduledSlot(new Date('2026-11-24T23:59:30-06:00'), TZ, daily).toISOString(), '2026-11-25T05:59:00.000Z');
    assert.equal(parseDailyCron('*/5 * * * *'), undefined);
  });
  it('formatStamp usa la zona configurada, no la del sistema', () => {
    assert.equal(formatStamp(new Date('2026-11-25T05:59:00Z'), TZ), '2026-11-24_235900');
    assert.equal(zonedParts(new Date('2026-11-25T05:59:00Z'), TZ).d, 24);
  });
});

describe('Recuperación ante reinicios (#15)', () => {
  const now = new Date('2026-11-24T10:00:00-06:00'); // el hueco vencido fue el 23-nov 23:59
  const ev = (s: Partial<ServiceState>, n = now, enabled = true) => evaluateRecovery(n, { schemaVersion: 1, ...s }, CRON, TZ, enabled);

  it('se perdió la ejecución anterior -> se requiere recuperación', () => {
    assert.equal(ev({ lastCompletedAt: '2026-11-22T23:59:40-06:00' }).needed, true);
  });
  it('la ejecución programada ya fue cubierta -> no hay recuperación', () => {
    assert.equal(ev({ lastCompletedAt: '2026-11-23T23:59:40-06:00' }).needed, false);
    assert.equal(ev({ lastCompletedAt: '2026-11-24T08:00:00-06:00' }).needed, false, 'una manual posterior al hueco lo cubre');
  });
  it('varios días perdidos producen UNA sola decisión de recuperación', () => {
    const d = ev({ lastCompletedAt: '2026-11-10T23:59:40-06:00' });
    assert.equal(d.needed, true);
    assert.equal(d.slot?.toISOString(), '2026-11-24T05:59:00.000Z');
  });
  it('sin historial no se inventa una recuperación; con firstSeenAt antiguo sí', () => {
    assert.equal(ev({}).needed, false);
    assert.equal(ev({ firstSeenAt: '2026-11-20T09:00:00-06:00' }).needed, true);
    assert.equal(ev({ firstSeenAt: '2026-11-24T09:00:00-06:00' }).needed, false);
  });
  it('reinicio justo después de las 23:59 con la ejecución del día sin hacer -> recuperación', () => {
    assert.equal(ev({ lastCompletedAt: '2026-11-23T23:59:40-06:00' }, new Date('2026-11-24T23:59:30-06:00')).needed, true);
  });
  it('una ejecución interrumpida/fallida no cuenta como completada', () => {
    assert.equal(ev({ lastCompletedAt: '2026-11-22T23:59:40-06:00', lastRun: { runId: 'x', type: 'SCHEDULED', status: 'interrupted', startedAt: '2026-11-23T23:59:00-06:00', ok: 0, failed: 0, skipped: 3 } }).needed, true);
  });
  it('deshabilitada o cron no diario -> no aplica', () => {
    assert.equal(ev({ lastCompletedAt: '2026-11-01T00:00:00-06:00' }, now, false).needed, false);
    assert.equal(evaluateRecovery(now, { schemaVersion: 1, lastCompletedAt: '2026-11-01T00:00:00Z' }, '*/5 * * * *', TZ).needed, false);
  });

  it('copia RECOVERY: etiqueta, fecha/hora REALES y no sobrescribe el respaldo previo', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('calidad_mbc')];
      const prev = await createFakeBackup(h.cfg.paths.backupRoot, mysqlTarget('calidad_mbc'), new Date('2026-11-22T23:59:00-06:00'));
      const prevBytes = await fs.readFile(prev);
      h.clock.now = new Date('2026-11-24T10:05:07-06:00');
      const rec = await runBackup(h.ctx, { type: 'RECOVERY' });
      assert.equal(rec.status, 'success');
      const files = (await listFilesRecursive(h.cfg.paths.backupRoot)).filter((f) => f.endsWith('.sql.gz')).map((f) => path.basename(f));
      assert.deepEqual(files.sort(), ['2026-11-22_235900.sql.gz', '2026-11-24_100507_RECOVERY.sql.gz']);
      assert.deepEqual(await fs.readFile(prev), prevBytes);
      const newest = (await listBackups(h.cfg.paths.backupRoot, mysqlTarget('calidad_mbc')))[0]!;
      const m: Manifest = newest.manifest;
      assert.equal(m.runType, 'RECOVERY');
      assert.equal(m.startedAt, '2026-11-24T16:05:07.000Z', 'hora real de generación, no la del día perdido');
      const st = await h.ctx.state.read();
      assert.ok(st.lastRecoveryAt);
    } finally {
      await h.cleanup();
    }
  });

  it('al iniciar con ejecuciones perdidas el scheduler lanza exactamente UNA recuperación', async () => {
    const h = await makeHarness({ env: { RECOVERY_DELAY_SECONDS: '0' } });
    try {
      await h.ctx.state.update((s) => {
        s.lastCompletedAt = '2026-11-10T23:59:40-06:00';
      });
      const calls: string[] = [];
      const sched = new BackupScheduler(h.ctx, async (_c, o) => {
        calls.push(o.type);
        return {} as never;
      });
      assert.equal(await sched.scheduleRecoveryIfNeeded(), true);
      await new Promise((r) => setTimeout(r, 100));
      await sched.shutdown(1000);
      assert.deepEqual(calls, ['RECOVERY']);
    } finally {
      await h.cleanup();
    }
  });

  it('ejecución interrumpida: se marca "interrupted" y no cuenta como completada (dispara recuperación)', async () => {
    const h = await makeHarness();
    try {
      const runId = '2026-11-23-235900-abcd';
      await h.ctx.state.writeRun({ runId, type: 'SCHEDULED', dryRun: false, status: 'running', startedAt: '2026-11-24T05:59:00.000Z', node: '22', discovered: { mysql: [], sqlite: [] }, results: [], errors: [] });
      await h.ctx.state.update((s) => {
        s.currentRun = { runId, type: 'SCHEDULED', startedAt: '2026-11-24T05:59:00.000Z', pid: 2_000_000_000 };
        s.lastCompletedAt = '2026-11-22T23:59:40-06:00';
      });
      assert.equal(await reconcileInterruptedRun(h.ctx), runId);
      assert.equal((await h.ctx.state.readRun(runId))!.status, 'interrupted');
      const st = await h.ctx.state.read();
      assert.equal(st.currentRun, undefined);
      assert.equal(st.lastRun!.status, 'interrupted');
      assert.equal(evaluateRecovery(now, st, CRON, TZ).needed, true);
    } finally {
      await h.cleanup();
    }
  });

  it('no marca como interrumpida una ejecución cuyo proceso sigue vivo con bloqueo vigente', async () => {
    const h = await makeHarness();
    try {
      const lock = await acquireLock(h.cfg.paths.lockFile, { staleMs: 600_000 });
      await h.ctx.state.update((s) => {
        s.currentRun = { runId: 'viva', type: 'SCHEDULED', startedAt: new Date().toISOString(), pid: process.pid };
      });
      assert.equal(await reconcileInterruptedRun(h.ctx), undefined);
      assert.ok((await h.ctx.state.read()).currentRun);
      await lock.release();
    } finally {
      await h.cleanup();
    }
  });

  it('limpia SOLO temporales propios y abandonados (antigüedad) y deja intactos los respaldos y archivos ajenos', async () => {
    const h = await makeHarness();
    try {
      const root = h.cfg.paths.backupRoot;
      const t = mysqlTarget('calidad_mbc');
      const valid = await createFakeBackup(root, t, new Date('2026-11-20T23:59:00-06:00'));
      const dir = path.dirname(valid);
      const old = new Date(Date.now() - 5 * 3_600_000);
      const mk = async (p: string, aged: boolean) => {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, 'x');
        if (aged) await fs.utimes(p, old, old);
        return p;
      };
      const orphanPartial = await mk(path.join(dir, '2026-11-21_235900.sql.gz.partial'), true);
      const freshPartial = await mk(path.join(dir, '2026-11-24_235900.sql.gz.partial'), false);
      const foreign = await mk(path.join(dir, 'otra-app.partial'), true);
      const tmpCnf = await mk(path.join(h.cfg.paths.tempDir, 'mysqldump-1-abc.cnf'), true);
      const tmpDb = await mk(path.join(h.cfg.paths.tempDir, 'sqlite-r-kpis.partial-db'), true);
      const tmpFresh = await mk(path.join(h.cfg.paths.tempDir, 'sqlite-r-nuevo.partial-db'), false);
      const tmpOther = await mk(path.join(h.cfg.paths.tempDir, 'notas.txt'), true);
      const removed = await cleanOrphans(h.ctx);
      assert.deepEqual(removed.sort(), [orphanPartial, tmpCnf, tmpDb].sort());
      for (const keep of [valid, valid + MANIFEST_SUFFIX, freshPartial, foreign, tmpFresh, tmpOther]) assert.ok(await fs.stat(keep), keep);
    } finally {
      await h.cleanup();
    }
  });

  it('una ejecución interrumpida y reiniciada produce respaldos válidos sin restos', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('calidad_mbc')];
      // restos de un proceso que murió a media copia
      const t = mysqlTarget('calidad_mbc');
      const prev = await createFakeBackup(h.cfg.paths.backupRoot, t, new Date('2026-11-20T23:59:00-06:00'));
      const orphan = path.join(path.dirname(prev), '2026-11-23_235900.sql.gz.partial');
      await fs.writeFile(orphan, 'trunc');
      const old = new Date(Date.now() - 3 * 3_600_000);
      await fs.utimes(orphan, old, old);
      const rec = await runBackup(h.ctx, { type: 'RECOVERY' });
      assert.equal(rec.status, 'success');
      await assert.rejects(fs.stat(orphan));
    } finally {
      await h.cleanup();
    }
  });
});
