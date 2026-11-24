import type { AppConfig } from './config/load.js';
import type { Logger } from './logging/logger.js';
import type { MysqlConnector } from './discovery/mysql.js';
import { Mysql2Connector } from './discovery/mysql.js';
import { StateStore } from './storage/state.js';
import { freeBytes } from './storage/disk.js';
import { NodeToolRunner, type ToolRunner } from './util/process.js';

export interface AppContext {
  cfg: AppConfig;
  log: Logger;
  runner: ToolRunner;
  mysql: MysqlConnector;
  state: StateStore;
  /** Variables de entorno desde las que se leen las contraseñas (passwordEnv). */
  secrets: NodeJS.ProcessEnv;
  now: () => Date;
  freeBytes: (dir: string) => Promise<number>;
}

export interface ContextOverrides {
  runner?: ToolRunner;
  mysql?: MysqlConnector;
  secrets?: NodeJS.ProcessEnv;
  now?: () => Date;
  freeBytes?: (dir: string) => Promise<number>;
}

export function createContext(cfg: AppConfig, log: Logger, overrides: ContextOverrides = {}): AppContext {
  return {
    cfg,
    log,
    runner: overrides.runner ?? new NodeToolRunner(),
    mysql: overrides.mysql ?? new Mysql2Connector(),
    state: new StateStore(cfg.paths.stateFile, cfg.paths.runsDir, cfg.env.RUN_HISTORY_KEEP),
    secrets: overrides.secrets ?? process.env,
    now: overrides.now ?? (() => new Date()),
    freeBytes: overrides.freeBytes ?? freeBytes,
  };
}
