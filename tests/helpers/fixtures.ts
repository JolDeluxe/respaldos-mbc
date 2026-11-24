import fs from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_SUFFIX, monthDir } from '../../src/storage/layout.js';
import { safeSegment } from '../../src/util/fsx.js';
import { formatStamp } from '../../src/util/time.js';
import type { BackupTarget, Manifest } from '../../src/types.js';

export function mysqlTarget(db: string, instanceId = 'principal'): BackupTarget {
  return {
    key: `mysql:${instanceId}:${db}`,
    engine: 'mysql',
    databaseId: db,
    instanceId,
    sourceName: db,
    displayName: db,
    segments: [safeSegment(db)],
    estimatedBytes: 0,
  };
}

export function sqliteTarget(id: string, file = 'x.db'): BackupTarget {
  return {
    key: `sqlite:${id}`,
    engine: 'sqlite',
    databaseId: id,
    sourceName: file,
    displayName: id,
    segments: [safeSegment(id)],
    estimatedBytes: 0,
    sqlitePath: file,
  };
}

/** Crea un respaldo "publicado" sintético (archivo + manifiesto válido). */
export async function createFakeBackup(root: string, target: BackupTarget, when: Date, tz = 'America/Mexico_City'): Promise<string> {
  const dir = monthDir(root, target, when, tz);
  await fs.mkdir(dir, { recursive: true });
  const ext = target.engine === 'mysql' ? 'sql.gz' : 'sqlite.gz';
  const fileName = `${formatStamp(when, tz)}.${ext}`;
  const content = Buffer.from(`respaldo ${target.key} ${when.toISOString()}`);
  await fs.writeFile(path.join(dir, fileName), content);
  const m: Manifest = {
    schemaVersion: 1,
    databaseId: target.databaseId,
    engine: target.engine,
    instanceId: target.instanceId,
    sourceName: target.sourceName,
    displayName: target.displayName,
    runId: 'fake',
    runType: 'SCHEDULED',
    startedAt: when.toISOString(),
    finishedAt: new Date(when.getTime() + 1000).toISOString(),
    durationMs: 1000,
    fileName,
    relativePath: fileName,
    sizeBytes: content.length,
    sha256: 'x',
    contentSha256: 'y',
    contentBytes: 1,
    validation: { result: 'ok', checks: [] },
    tool: { name: 'fake', version: '0' },
    status: 'success',
  };
  await fs.writeFile(path.join(dir, fileName + MANIFEST_SUFFIX), JSON.stringify(m));
  return path.join(dir, fileName);
}

export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out.sort();
}
