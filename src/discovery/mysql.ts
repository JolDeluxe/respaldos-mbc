import mysql from 'mysql2/promise';
import { ALWAYS_EXCLUDED_SCHEMAS, type MysqlInstanceConfig } from '../config/schema.js';
import { BackupError } from '../util/errors.js';

export interface SchemaInfo {
  name: string;
  estimatedBytes: number;
  nonInnodbTables: number;
}

export interface SchemaListing {
  serverVersion: string;
  schemas: SchemaInfo[];
  warnings: string[];
}

/** Abstracción de la conexión MySQL (sustituible en pruebas). Solo consultas de metadatos. */
export interface MysqlConnector {
  listSchemas(instance: MysqlInstanceConfig, password: string): Promise<SchemaListing>;
}

export class Mysql2Connector implements MysqlConnector {
  async listSchemas(instance: MysqlInstanceConfig, password: string): Promise<SchemaListing> {
    let conn: mysql.Connection;
    try {
      conn = await mysql.createConnection({
        host: instance.host,
        port: instance.port,
        user: instance.user,
        password,
        connectTimeout: instance.connectTimeoutMs,
        charset: 'utf8mb4',
        multipleStatements: false,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // No se incluye el mensaje completo para no filtrar datos de conexión.
      throw new BackupError(
        'CONNECTION_FAILED',
        `No se pudo conectar a MySQL "${instance.id}" (${instance.host}:${instance.port}): ${e.code ?? 'ERROR'}`,
        { cause: err },
      );
    }
    try {
      const warnings: string[] = [];
      const [verRows] = await conn.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
      const serverVersion = String(verRows[0]?.v ?? 'desconocida');
      const [nameRows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
      );
      const sizes = new Map<string, { bytes: number; nonInnodb: number }>();
      try {
        const [sizeRows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT TABLE_SCHEMA AS schema_name,
                  COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes,
                  COALESCE(SUM(TABLE_TYPE = 'BASE TABLE' AND ENGINE <> 'InnoDB'), 0) AS non_innodb
             FROM information_schema.TABLES GROUP BY TABLE_SCHEMA`,
        );
        for (const r of sizeRows) {
          sizes.set(String(r.schema_name), { bytes: Number(r.bytes), nonInnodb: Number(r.non_innodb) });
        }
      } catch (err) {
        warnings.push(`No se pudo estimar el tamaño de los esquemas: ${(err as Error).message}`);
      }
      const schemas = nameRows.map((r) => {
        const name = String(r.name);
        const s = sizes.get(name);
        return { name, estimatedBytes: s?.bytes ?? 0, nonInnodbTables: s?.nonInnodb ?? 0 };
      });
      return { serverVersion, schemas, warnings };
    } catch (err) {
      throw new BackupError('CONNECTION_FAILED', `Fallo consultando esquemas de MySQL "${instance.id}": ${(err as Error).message}`, {
        cause: err,
      });
    } finally {
      await conn.end().catch(() => undefined);
    }
  }
}

export interface SchemaSelection {
  selected: SchemaInfo[];
  skipped: Array<{ name: string; reason: string }>;
  missing: string[];
}

/** Aplica las exclusiones obligatorias y las configuradas. */
export function selectSchemas(all: SchemaInfo[], instance: MysqlInstanceConfig): SchemaSelection {
  const always = new Set<string>(ALWAYS_EXCLUDED_SCHEMAS);
  const excluded = new Set(instance.excludeSchemas.map((s) => s.toLowerCase()));
  const included = new Set(instance.includeSchemas.map((s) => s.toLowerCase()));
  const selected: SchemaInfo[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const s of all) {
    const lower = s.name.toLowerCase();
    if (always.has(lower)) skipped.push({ name: s.name, reason: 'esquema del sistema' });
    else if (excluded.has(lower)) skipped.push({ name: s.name, reason: 'excluido por configuración' });
    else if (!instance.autoDiscover && !included.has(lower)) skipped.push({ name: s.name, reason: 'no incluido (autoDiscover=false)' });
    else selected.push(s);
  }
  const present = new Set(all.map((s) => s.name.toLowerCase()));
  const missing = instance.autoDiscover ? [] : instance.includeSchemas.filter((n) => !present.has(n.toLowerCase()));
  return { selected, skipped, missing };
}
