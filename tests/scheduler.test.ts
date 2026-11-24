import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runBackup } from '../src/backup/runner.js';
import { BackupScheduler } from '../src/scheduler/scheduler.js';
import { zonedParts } from '../src/util/time.js';
import { listFilesRecursive } from './helpers/fixtures.js';
import { makeHarness, schema } from './helpers/harness.js';

describe('Programador y apagado ordenado (#19)', () => {
  it('programa la ejecución diaria a las 23:59 America/Mexico_City', async () => {
    const h = await makeHarness();
    const sched = new BackupScheduler(h.ctx, async () => ({}) as never);
    try {
      sched.start();
      const next = sched.nextRun()!;
      assert.ok(next, 'debe haber próxima ejecución');
      const p = zonedParts(next, 'America/Mexico_City');
      assert.deepEqual([p.h, p.mi, p.s], [23, 59, 0]);
      assert.ok(next.getTime() > Date.now());
    } finally {
      assert.equal(await sched.shutdown(500), 'idle');
      await h.cleanup();
    }
  });

  it('no permite solapamiento dentro del proceso', async () => {
    const h = await makeHarness();
    let calls = 0;
    const sched = new BackupScheduler(h.ctx, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 150));
      return {} as never;
    });
    try {
      const first = sched.trigger('SCHEDULED');
      assert.ok(first);
      assert.equal(sched.trigger('MANUAL'), undefined, 'la segunda se omite');
      await first;
      assert.equal(calls, 1);
      assert.ok(sched.trigger('SCHEDULED'), 'tras terminar se permite otra');
      await sched.shutdown(2000);
    } finally {
      await h.cleanup();
    }
  });

  it('apagado con ejecución activa dentro del tiempo de gracia: la deja terminar', async () => {
    const h = await makeHarness();
    let finished = false;
    const sched = new BackupScheduler(h.ctx, async () => {
      await new Promise((r) => setTimeout(r, 200));
      finished = true;
      return {} as never;
    });
    try {
      sched.trigger('SCHEDULED');
      assert.equal(await sched.shutdown(5000), 'completed');
      assert.ok(finished);
      assert.equal(sched.trigger('MANUAL'), undefined, 'no se aceptan ejecuciones tras el apagado');
    } finally {
      await h.cleanup();
    }
  });

  it('apagado inmediato: no se inician nuevas bases (quedan omitidas, estado interrupted)', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('a'), schema('b'), schema('c')];
      const sched = new BackupScheduler(h.ctx);
      const p = sched.trigger('SCHEDULED');
      assert.equal(await sched.shutdown(10_000), 'completed');
      await p;
      const st = await h.ctx.state.read();
      assert.equal(st.lastRun!.status, 'interrupted');
      assert.equal(st.lastCompletedAt, undefined, 'una ejecución interrumpida no cuenta como completada');
      assert.equal((await listFilesRecursive(h.cfg.paths.backupRoot)).filter((f) => f.endsWith('.partial')).length, 0);
      await assert.rejects(fs.stat(h.cfg.paths.lockFile), 'el bloqueo debe liberarse');
    } finally {
      await h.cleanup();
    }
  });

  it('apagado con exportación atascada: tras el tiempo de gracia se cancela, se limpia y se libera el bloqueo', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('antes_ok'), schema('colgada'), schema('despues')];
      h.runner.hangSchemas.add('colgada');
      const started = new Promise<void>((resolve) => (h.runner.hangStarted = resolve));
      const sched = new BackupScheduler(h.ctx);
      const p = sched.trigger('SCHEDULED');
      await started;
      const outcome = await sched.shutdown(150);
      assert.equal(outcome, 'aborted');
      await p;
      const files = await listFilesRecursive(h.cfg.paths.backupRoot);
      assert.ok(files.every((f) => !f.endsWith('.partial')), 'sin .partial');
      assert.ok(files.some((f) => /antes_ok[\\/].*\.sql\.gz$/.test(f)), 'lo ya terminado se conserva');
      assert.ok(!files.some((f) => /despues[\\/]/.test(f)), 'no se inició la base posterior');
      assert.deepEqual(await fs.readdir(h.cfg.paths.tempDir), [], 'archivo de credenciales eliminado');
      await assert.rejects(fs.stat(h.cfg.paths.lockFile));
      const st = await h.ctx.state.read();
      assert.equal(st.lastRun!.status, 'interrupted');
      assert.equal(st.currentRun, undefined);
    } finally {
      await h.cleanup();
    }
  });

  it('un error de la ejecución no tumba el programador y el bloqueo ocupado se registra como omitida', async () => {
    const h = await makeHarness();
    try {
      h.mysql.schemas = [schema('x')];
      const sched = new BackupScheduler(h.ctx, async (c, o) => {
        if (o.type === 'MANUAL') throw new Error('boom');
        return runBackup(c, o);
      });
      await sched.trigger('MANUAL');
      assert.ok(h.logLines.some((l) => l.includes('La ejecución terminó con error')));
      await sched.trigger('SCHEDULED');
      assert.equal((await h.ctx.state.read()).lastRun!.status, 'success');
      await sched.shutdown(500);
    } finally {
      await h.cleanup();
    }
  });
});

describe('Ecosistema PM2 (#12)', () => {
  it('cumple la configuración exigida', async () => {
    const { createRequire } = await import('node:module');
    const eco = createRequire(import.meta.url)(path.resolve('ecosystem.config.cjs')) as { apps: Array<Record<string, unknown>> };
    assert.equal(eco.apps.length, 1);
    const app = eco.apps[0]!;
    assert.equal(app.name, 'mbc-backup-service');
    assert.equal(app.instances, 1);
    assert.equal(app.exec_mode, 'fork');
    assert.equal(app.autorestart, true);
    assert.equal(app.watch, false);
    assert.ok(Number(app.restart_delay) >= 5000);
    assert.ok(Number(app.kill_timeout) >= 90_000 + 30_000);
    assert.equal(app.shutdown_with_message, true);
    assert.equal(app.max_memory_restart, undefined, 'sin reinicio por memoria a mitad de una copia');
    assert.equal((app.env as Record<string, string>).ENABLE_SCHEDULER, 'true');
  });
});
