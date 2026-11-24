import fs from 'node:fs/promises';
import { assertOwned, listBackups } from '../storage/layout.js';
import { errMessage } from '../util/errors.js';
import type { AppContext } from '../context.js';
import type { BackupTarget } from '../types.js';

export interface RetentionResult {
  kept: number;
  deleted: string[];
  errors: string[];
}

/**
 * Retención INDEPENDIENTE por base: conserva los últimos N respaldos válidos y elimina únicamente
 * los más antiguos de ESA base (archivo + manifiesto), tras comprobar que le pertenecen.
 * No elimina directorios ni toca archivos desconocidos.
 */
export async function applyRetention(ctx: AppContext, target: BackupTarget, keep = ctx.cfg.env.RETENTION_COUNT): Promise<RetentionResult> {
  const root = ctx.cfg.paths.backupRoot;
  const listed = await listBackups(root, target);
  const valid = listed.filter((b) => b.valid);
  const result: RetentionResult = { kept: Math.min(valid.length, keep), deleted: [], errors: [] };

  // Protección: nunca dejar la base sin respaldos válidos.
  if (valid.length === 0 || keep < 1) return result;

  for (const old of valid.slice(keep)) {
    try {
      if (!assertOwned(root, target, old.filePath) || !assertOwned(root, target, old.manifestPath)) {
        result.errors.push(`${old.manifest.fileName}: no pertenece al sistema, omitido`);
        continue;
      }
      await fs.rm(old.filePath, { force: true });
      await fs.rm(old.manifestPath, { force: true });
      result.deleted.push(old.manifest.fileName);
    } catch (err) {
      result.errors.push(`${old.manifest.fileName}: ${errMessage(err)}`);
    }
  }
  // Manifiestos huérfanos (archivo ausente) de ESTA base: se limpian solo si ya existen suficientes válidos.
  for (const b of listed.filter((x) => !x.valid && x.reason === 'archivo ausente')) {
    try {
      if (assertOwned(root, target, b.manifestPath)) await fs.rm(b.manifestPath, { force: true });
    } catch (err) {
      result.errors.push(`${b.manifest.fileName}: ${errMessage(err)}`);
    }
  }
  ctx.log.info(
    { database: target.key, keep, validBefore: valid.length, deleted: result.deleted, errors: result.errors },
    'Retención aplicada',
  );
  return result;
}
