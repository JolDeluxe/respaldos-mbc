import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createMemoryLogger, RotatingFileStream } from '../src/logging/logger.js';
import { StateStore } from '../src/storage/state.js';
import { BackupError } from '../src/util/errors.js';
import { atomicWriteJson, readJsonIfExists } from '../src/util/fsx.js';
import { NodeToolRunner, redactSecrets } from '../src/util/process.js';
import { clientOlderThanServer } from '../src/backup/tools.js';
import { makeTmp } from './helpers/harness.js';

const node = process.execPath;

describe('Ejecución de procesos externos reales (NodeToolRunner)', () => {
  const runner = new NodeToolRunner();
  it('run: captura stdout/código', async () => {
    const r = await runner.run(node, ['-e', 'console.log("hola"); process.exit(3)']);
    assert.equal(r.code, 3);
    assert.equal(r.stdout.trim(), 'hola');
  });
  it('ejecutable inexistente -> TOOL_MISSING', async () => {
    await assert.rejects(runner.run('no-existe-xyz-123', []), (e) => e instanceof BackupError && e.code === 'TOOL_MISSING');
  });
  it('tiempo de espera agotado', async () => {
    await assert.rejects(runner.run(node, ['-e', 'setTimeout(()=>{}, 30000)'], { timeoutMs: 300 }), /Tiempo de espera/);
  });
  it('abort cancela el proceso hijo', async () => {
    const ac = new AbortController();
    const p = runner.run(node, ['-e', 'setTimeout(()=>{}, 30000)'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await assert.rejects(p, (e) => e instanceof BackupError && e.code === 'ABORTED');
  });
  it('stream: entrega stdout por flujo y resuelve done', async () => {
    const h = runner.stream(node, ['-e', 'process.stdout.write("a".repeat(100000)); process.stderr.write("aviso")']);
    let n = 0;
    for await (const c of h.stdout) n += (c as Buffer).length;
    const d = await h.done;
    assert.equal(n, 100000);
    assert.equal(d.code, 0);
    assert.equal(d.stderrTail, 'aviso');
  });
  it('stream con ejecutable inexistente: done informa spawnError y el flujo falla', async () => {
    const h = runner.stream('no-existe-xyz-123', []);
    await assert.rejects(async () => {
      for await (const _ of h.stdout) void _;
    });
    assert.match((await h.done).spawnError ?? '', /ENOENT/);
  });
  it('redactSecrets elimina contraseñas', () => {
    assert.equal(redactSecrets('error using password: hunter22 ok', ['hunter22', undefined]), 'error using password: *** ok');
  });
  it('comparación de versiones cliente/servidor', () => {
    assert.equal(clientOlderThanServer('8.0.43', '8.4.3'), true);
    assert.equal(clientOlderThanServer('8.4.0', '8.4.3'), false);
    assert.equal(clientOlderThanServer('9.0.0', '8.4.3'), false);
  });
});

describe('Estado atómico y logs', () => {
  it('escritura atómica: sin temporales y tolera restos de una escritura interrumpida', async () => {
    const tmp = await makeTmp();
    const f = path.join(tmp, 'state', 'state.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => atomicWriteJson(f, { schemaVersion: 1, n: i })));
    const names = await fs.readdir(path.dirname(f));
    assert.deepEqual(names, ['state.json']);
    JSON.parse(await fs.readFile(f, 'utf8')); // siempre JSON completo
    await fs.writeFile(`${f}.123.dead.tmp`, '{ truncado'); // resto de un apagado a media escritura
    assert.equal((await readJsonIfExists<{ schemaVersion: number }>(f))!.schemaVersion, 1);
    await fs.rm(tmp, { recursive: true, force: true });
  });
  it('un state.json corrupto no impide iniciar (se parte de estado vacío)', async () => {
    const tmp = await makeTmp();
    await fs.writeFile(path.join(tmp, 's.json'), '{{{ corrupto');
    const s = new StateStore(path.join(tmp, 's.json'), path.join(tmp, 'runs'), 5);
    assert.deepEqual(await s.read(), { schemaVersion: 1 });
    await fs.rm(tmp, { recursive: true, force: true });
  });
  it('conserva solo los últimos N registros de ejecución y no toca otros archivos', async () => {
    const tmp = await makeTmp();
    const s = new StateStore(path.join(tmp, 's.json'), path.join(tmp, 'runs'), 5);
    for (let i = 0; i < 9; i++) await atomicWriteJson(path.join(tmp, 'runs', `run-2026-11-0${i + 1}-x.json`), { i });
    await fs.writeFile(path.join(tmp, 'runs', 'ajeno.json'), '{}');
    assert.equal(await s.pruneRuns(), 4);
    assert.deepEqual((await fs.readdir(path.join(tmp, 'runs'))).sort(), ['ajeno.json', 'run-2026-11-05-x.json', 'run-2026-11-06-x.json', 'run-2026-11-07-x.json', 'run-2026-11-08-x.json', 'run-2026-11-09-x.json']);
    await fs.rm(tmp, { recursive: true, force: true });
  });
  it('rotación de logs por tamaño con máximo de archivos', async () => {
    const tmp = await makeTmp();
    const s = new RotatingFileStream(tmp, 'x.log', 200, 3);
    for (let i = 0; i < 40; i++) s.write(`linea numero ${i} ${'x'.repeat(30)}\n`);
    const names = (await fs.readdir(tmp)).sort();
    assert.deepEqual(names, ['x.log', 'x.log.1', 'x.log.2', 'x.log.3']);
    for (const n of names) assert.ok((await fs.stat(path.join(tmp, n))).size <= 300);
    await fs.rm(tmp, { recursive: true, force: true });
  });
  it('el logger enmascara contraseñas en campos conocidos', () => {
    const lines: string[] = [];
    const log = createMemoryLogger(lines);
    log.info({ password: 'hunter2', conexion: { password: 'otra' } }, 'prueba');
    const text = lines.join('');
    assert.ok(!text.includes('hunter2') && !text.includes('otra"'));
    assert.match(text, /\*\*\*/);
  });
});

describe('Compatibilidad con Node.js (#20)', () => {
  it('package.json declara las ramas soportadas (22.18+ y 26+)', async () => {
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
    assert.equal(pkg.engines.node, '>=22.18.0 <23 || >=26.0.0');
    assert.equal(pkg.type, 'module');
  });
  it('las APIs de plataforma usadas están disponibles en este Node', async () => {
    assert.equal(typeof fs.statfs, 'function');
    assert.equal(typeof AbortController, 'function');
    assert.equal(typeof (await import('node:sqlite')).backup, 'function');
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City' }));
    assert.equal(typeof (await import('node:zlib')).createGzip, 'function');
    assert.equal(typeof (await import('node:crypto')).createHash, 'function');
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
  });
  it('sin dependencias nativas (solo JavaScript)', async () => {
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['dotenv', 'mysql2', 'node-cron', 'pino', 'zod']);
    const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8')) as { packages: Record<string, { hasInstallScript?: boolean; dev?: boolean }> };
    // Ninguna dependencia de PRODUCCIÓN ejecuta scripts de instalación (compilación nativa).
    const withScripts = Object.entries(lock.packages).filter(([k, v]) => k && v.hasInstallScript && !v.dev);
    assert.deepEqual(withScripts.map(([k]) => k), [], 'ningún paquete de producción requiere compilar en la instalación');
  });
});
