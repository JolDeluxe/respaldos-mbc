import fs from 'node:fs/promises';
import path from 'node:path';
import { isInside, resolveInside } from '../util/fsx.js';
import { yearMonth } from '../util/time.js';
import type { BackupTarget, Manifest, RunType } from '../types.js';

/** <stamp>[_RECOVERY|_MANUAL][-n].(sql|sqlite).gz */
export const BACKUP_FILE_RE = /^(\d{4}-\d{2}-\d{2}_\d{6})(?:_(RECOVERY|MANUAL))?(?:-(\d+))?\.(sql|sqlite)\.gz$/;
export const PARTIAL_FILE_RE = /^\d{4}-\d{2}-\d{2}_\d{6}(?:_(?:RECOVERY|MANUAL))?(?:-\d+)?\.(?:sql|sqlite)\.gz\.partial$/;
export const MANIFEST_SUFFIX = '.manifest.json';

export function extensionFor(target: BackupTarget): string {
  return target.engine === 'mysql' ? 'sql.gz' : 'sqlite.gz';
}

export function targetDir(backupRoot: string, target: BackupTarget): string {
  return resolveInside(backupRoot, target.engine, ...target.segments);
}

export function monthDir(backupRoot: string, target: BackupTarget, when: Date, tz: string): string {
  const { year, month } = yearMonth(when, tz);
  return resolveInside(backupRoot, target.engine, ...target.segments, year, month);
}

export function backupFileName(stamp: string, type: RunType, target: BackupTarget, seq: number): string {
  const label = type === 'RECOVERY' ? '_RECOVERY' : type === 'MANUAL' ? '_MANUAL' : '';
  return `${stamp}${label}${seq > 1 ? `-${seq}` : ''}.${extensionFor(target)}`;
}

export interface ListedBackup {
  manifest: Manifest;
  filePath: string;
  manifestPath: string;
  valid: boolean;
  reason?: string;
}

function belongs(m: Manifest, t: BackupTarget): boolean {
  return m.databaseId === t.databaseId && m.engine === t.engine && (m.instanceId ?? undefined) === (t.instanceId ?? undefined);
}

/**
 * Lista los respaldos de UNA base leyendo únicamente su propio directorio.
 * Un respaldo es válido si su manifiesto es legible, pertenece a la base, el archivo existe y el tamaño coincide.
 * Ordenado del más reciente al más antiguo.
 */
export async function listBackups(backupRoot: string, target: BackupTarget): Promise<ListedBackup[]> {
  const base = targetDir(backupRoot, target);
  const out: ListedBackup[] = [];
  const readdir = async (d: string) => fs.readdir(d, { withFileTypes: true }).catch(() => []);
  for (const y of await readdir(base)) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    for (const mo of await readdir(path.join(base, y.name))) {
      if (!mo.isDirectory() || !/^\d{2}$/.test(mo.name)) continue;
      const dir = path.join(base, y.name, mo.name);
      for (const f of await readdir(dir)) {
        if (!f.isFile() || !f.name.endsWith(MANIFEST_SUFFIX)) continue;
        const gzName = f.name.slice(0, -MANIFEST_SUFFIX.length);
        if (!BACKUP_FILE_RE.test(gzName)) continue;
        const manifestPath = path.join(dir, f.name);
        const filePath = path.join(dir, gzName);
        let manifest: Manifest;
        try {
          manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Manifest;
        } catch {
          continue; // ilegible: no es un respaldo válido y no se toca
        }
        if (!manifest || manifest.schemaVersion !== 1 || !belongs(manifest, target) || manifest.fileName !== gzName) continue;
        let valid = manifest.status === 'success' && manifest.validation?.result === 'ok';
        let reason: string | undefined;
        try {
          const st = await fs.stat(filePath);
          if (st.size !== manifest.sizeBytes || st.size === 0) {
            valid = false;
            reason = 'tamaño distinto al manifiesto';
          }
        } catch {
          valid = false;
          reason = 'archivo ausente';
        }
        out.push({ manifest, filePath, manifestPath, valid, reason });
      }
    }
  }
  out.sort((a, b) => (b.manifest.finishedAt + b.manifest.fileName).localeCompare(a.manifest.finishedAt + a.manifest.fileName));
  return out;
}

export function assertOwned(backupRoot: string, target: BackupTarget, file: string): boolean {
  const base = targetDir(backupRoot, target);
  const name = path.basename(file);
  return isInside(base, file) && (BACKUP_FILE_RE.test(name) || name.endsWith(MANIFEST_SUFFIX));
}
