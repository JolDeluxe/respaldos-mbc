import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, readJsonIfExists } from '../util/fsx.js';
import type { RunRecord, ServiceState } from '../types.js';

export class StateStore {
  constructor(
    private readonly stateFile: string,
    private readonly runsDir: string,
    private readonly keepRuns: number,
  ) {}

  async read(): Promise<ServiceState> {
    const s = await readJsonIfExists<ServiceState>(this.stateFile);
    return s && s.schemaVersion === 1 ? s : { schemaVersion: 1 };
  }

  async update(fn: (s: ServiceState) => void): Promise<ServiceState> {
    const s = await this.read();
    fn(s);
    await atomicWriteJson(this.stateFile, s);
    return s;
  }

  runFile(runId: string): string {
    return path.join(this.runsDir, `run-${runId}.json`);
  }

  async writeRun(record: RunRecord): Promise<void> {
    await atomicWriteJson(this.runFile(record.runId), record);
  }

  async readRun(runId: string): Promise<RunRecord | undefined> {
    return readJsonIfExists<RunRecord>(this.runFile(runId));
  }

  /** Conserva los últimos N registros de ejecución (solo archivos propios `run-*.json`). */
  async pruneRuns(): Promise<number> {
    let names: string[];
    try {
      names = (await fs.readdir(this.runsDir)).filter((n) => /^run-[\w.-]+\.json$/.test(n));
    } catch {
      return 0;
    }
    names.sort();
    const excess = names.slice(0, Math.max(0, names.length - this.keepRuns));
    for (const n of excess) await fs.rm(path.join(this.runsDir, n), { force: true });
    return excess.length;
  }

  async listRuns(limit = 10): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.runsDir)).filter((n) => /^run-[\w.-]+\.json$/.test(n));
    } catch {
      return [];
    }
    names.sort().reverse();
    const out: RunRecord[] = [];
    for (const n of names.slice(0, limit)) {
      const r = await readJsonIfExists<RunRecord>(path.join(this.runsDir, n));
      if (r) out.push(r);
    }
    return out;
  }
}
