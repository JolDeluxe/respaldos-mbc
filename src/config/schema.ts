import path from 'node:path';
import { z } from 'zod';

/** Identificador seguro para usarse como nombre de directorio y clave interna. */
export const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/i, 'Identificador inválido: use letras, números, "_" o "-" (máx. 63).');

const absolutePath = z.string().refine((p) => path.win32.isAbsolute(p) || path.posix.isAbsolute(p), {
  message: 'La ruta debe ser absoluta.',
});

export const mysqlInstanceSchema = z.object({
  id: idSchema,
  name: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(3306),
  user: z.string().min(1),
  /** Nombre de la variable de entorno que contiene la contraseña (nunca la contraseña). */
  passwordEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/i, 'Nombre de variable de entorno inválido.'),
  autoDiscover: z.boolean().default(true),
  excludeSchemas: z.array(z.string()).default([]),
  /** Solo se usa si autoDiscover=false: lista explícita de esquemas. */
  includeSchemas: z.array(z.string()).default([]),
  /**
   * false: carpeta mysql/<esquema>. true: mysql/<instancia>/<esquema>.
   * Solo una instancia habilitada puede usar el diseño plano.
   */
  namespaced: z.boolean().default(false),
  connectTimeoutMs: z.number().int().min(1000).max(120000).default(10000),
});

export const sqliteEntrySchema = z.object({
  id: idSchema,
  name: z.string().min(1).optional(),
  path: absolutePath,
  enabled: z.boolean().default(true),
});

/** Esquemas del sistema que NUNCA se respaldan, aunque no se declaren. */
export const ALWAYS_EXCLUDED_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'] as const;

export const databasesFileSchema = z
  .object({
    mysql: z.array(mysqlInstanceSchema).default([]),
    sqlite: z.array(sqliteEntrySchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.mysql.forEach((m, i) => {
      if (seen.has(`mysql:${m.id.toLowerCase()}`)) {
        ctx.addIssue({ code: 'custom', path: ['mysql', i, 'id'], message: `Identificador MySQL duplicado: ${m.id}` });
      }
      seen.add(`mysql:${m.id.toLowerCase()}`);
    });
    const sqliteIds = new Set<string>();
    cfg.sqlite.forEach((s, i) => {
      if (sqliteIds.has(s.id.toLowerCase())) {
        ctx.addIssue({ code: 'custom', path: ['sqlite', i, 'id'], message: `Identificador SQLite duplicado: ${s.id}` });
      }
      sqliteIds.add(s.id.toLowerCase());
    });
    const flat = cfg.mysql.filter((m) => m.enabled && !m.namespaced);
    if (flat.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['mysql'],
        message:
          'Solo una instancia MySQL habilitada puede usar el diseño plano (namespaced=false). Marque las demás con "namespaced": true.',
      });
    }
    cfg.mysql.forEach((m, i) => {
      if (!m.autoDiscover && m.includeSchemas.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['mysql', i, 'includeSchemas'],
          message: 'Con autoDiscover=false debe indicar includeSchemas.',
        });
      }
    });
  });

export type MysqlInstanceConfig = z.infer<typeof mysqlInstanceSchema>;
export type SqliteEntryConfig = z.infer<typeof sqliteEntrySchema>;
export type DatabasesFile = z.infer<typeof databasesFileSchema>;

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const numFromEnv = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().finite().min(min).max(max));

export const pathStringSchema = z.string().min(1);

export const envSchema = z.object({
  MBC_MODE: z.enum(['development', 'production']).default('development'),
  MBC_ALLOW_LIVE: bool.default(false),
  ENABLE_SCHEDULER: bool.default(false),
  BACKUP_ROOT: pathStringSchema.default('.local-backups'),
  RUNTIME_DIR: z.string().default('runtime'),
  CONFIG_PATH: z.string().default('config/databases.json'),
  SQLITE3_PATH: z.string().default('C:\\Servidor\\Herramientas\\SQLite\\sqlite3.exe'),
  MYSQLDUMP_PATH: z.string().default('mysqldump'),
  CRON_EXPRESSION: z.string().default('59 23 * * *'),
  TIMEZONE: z.string().default('America/Mexico_City'),
  RETENTION_COUNT: numFromEnv(15, 1, 365),
  MIN_FREE_GB: numFromEnv(10, 0, 100000),
  GZIP_LEVEL: numFromEnv(4, 1, 9),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_MAX_MB: numFromEnv(10, 1, 1024),
  LOG_MAX_FILES: numFromEnv(10, 1, 365),
  LOG_TO_CONSOLE: bool.default(false),
  RECOVERY_ENABLED: bool.default(true),
  RECOVERY_DELAY_SECONDS: numFromEnv(120, 0, 3600),
  SHUTDOWN_GRACE_SECONDS: numFromEnv(90, 0, 3600),
  TOOL_TIMEOUT_MINUTES: numFromEnv(360, 1, 2880),
  LOCK_STALE_MINUTES: numFromEnv(10, 1, 1440),
  TEMP_MAX_AGE_HOURS: numFromEnv(1, 0, 720),
  RUN_HISTORY_KEEP: numFromEnv(60, 5, 1000),
});

export type EnvConfig = z.infer<typeof envSchema>;
