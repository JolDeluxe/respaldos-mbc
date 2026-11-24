import { selectSchemas } from './mysql.js';
import { BackupError, errMessage } from '../util/errors.js';
import { safeSegment } from '../util/fsx.js';
import type { AppContext } from '../context.js';
import type { BackupTarget } from '../types.js';

export interface DiscoveryResult {
  targets: BackupTarget[];
  mysqlServerVersions: Record<string, string>;
  discovered: { mysql: Array<{ instanceId: string; schemas: string[] }>; sqlite: string[] };
  errors: string[];
}

/** Descubre esquemas MySQL (automático) y toma el inventario SQLite del archivo de configuración. */
export async function discoverTargets(ctx: AppContext, opts: { mysql: boolean; sqlite: boolean }): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { targets: [], mysqlServerVersions: {}, discovered: { mysql: [], sqlite: [] }, errors: [] };

  if (opts.mysql) {
    for (const inst of ctx.cfg.databases.mysql.filter((m) => m.enabled)) {
      try {
        const password = ctx.secrets[inst.passwordEnv];
        if (!password) {
          throw new BackupError('CONFIG_INVALID', `La variable de entorno ${inst.passwordEnv} (contraseña de MySQL "${inst.id}") no está definida.`);
        }
        const listing = await ctx.mysql.listSchemas(inst, password);
        result.mysqlServerVersions[inst.id] = listing.serverVersion;
        const sel = selectSchemas(listing.schemas, inst);
        for (const w of listing.warnings) ctx.log.warn({ instance: inst.id }, w);
        for (const m of sel.missing) {
          const msg = `El esquema configurado "${m}" no existe en la instancia ${inst.id}`;
          result.errors.push(msg);
          ctx.log.warn({ instance: inst.id, schema: m }, msg);
        }
        for (const s of sel.skipped) ctx.log.debug({ instance: inst.id, schema: s.name, reason: s.reason }, 'Esquema omitido');
        for (const s of sel.selected) {
          const warnings: string[] = [];
          if (s.nonInnodbTables > 0) {
            warnings.push(`${s.nonInnodbTables} tabla(s) no InnoDB: --single-transaction no garantiza consistencia para ellas`);
          }
          result.targets.push({
            key: `mysql:${inst.id}:${s.name}`,
            engine: 'mysql',
            databaseId: s.name,
            instanceId: inst.id,
            sourceName: s.name,
            displayName: `${inst.id}/${s.name}`,
            segments: inst.namespaced ? [safeSegment(inst.id), safeSegment(s.name)] : [safeSegment(s.name)],
            estimatedBytes: s.estimatedBytes,
            mysql: inst,
            warnings,
          });
        }
        result.discovered.mysql.push({ instanceId: inst.id, schemas: sel.selected.map((s) => s.name) });
        ctx.log.info(
          { instance: inst.id, serverVersion: listing.serverVersion, detected: listing.schemas.length, selected: sel.selected.map((s) => s.name), skipped: sel.skipped.map((s) => s.name) },
          'Esquemas MySQL detectados',
        );
      } catch (err) {
        const msg = `[mysql:${inst.id}] ${errMessage(err)}`;
        result.errors.push(msg);
        ctx.log.error({ instance: inst.id }, msg);
      }
    }
  }

  if (opts.sqlite) {
    for (const s of ctx.cfg.databases.sqlite.filter((e) => e.enabled)) {
      result.targets.push({
        key: `sqlite:${s.id}`,
        engine: 'sqlite',
        databaseId: s.id,
        sourceName: s.path,
        displayName: s.name ?? s.id,
        segments: [safeSegment(s.id)],
        estimatedBytes: 0,
        sqlitePath: s.path,
      });
      result.discovered.sqlite.push(s.id);
    }
    ctx.log.info({ sqlite: result.discovered.sqlite }, 'Bases SQLite configuradas');
  }
  return result;
}
