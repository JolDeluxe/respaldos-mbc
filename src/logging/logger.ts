import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';

export type { Logger };

/** Destino de archivo con rotación por tamaño. Nunca lanza excepciones (el log no debe tumbar el servicio). */
export class RotatingFileStream {
  private size = 0;
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly baseName: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, baseName);
    try {
      this.size = fs.statSync(this.file).size;
    } catch {
      this.size = 0;
    }
  }

  write(chunk: string): void {
    try {
      const len = Buffer.byteLength(chunk);
      if (this.size > 0 && this.size + len > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, chunk);
      this.size += len;
    } catch {
      /* ignorar */
    }
  }

  private rotate(): void {
    try {
      fs.rmSync(`${this.file}.${this.maxFiles}`, { force: true });
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
      this.size = 0;
    } catch {
      /* si falla la rotación seguimos agregando al archivo actual */
    }
  }
}

export interface LoggerOptions {
  level: string;
  logDir: string;
  maxMb: number;
  maxFiles: number;
  console: boolean;
}

const REDACT = [
  'password',
  '*.password',
  'pass',
  '*.pass',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'MYSQL_PWD',
  'connectionString',
];

export function createLogger(opts: LoggerOptions): Logger {
  const file = new RotatingFileStream(opts.logDir, 'mbc-backup-service.log', opts.maxMb * 1024 * 1024, opts.maxFiles);
  const streams: pino.StreamEntry[] = [{ level: opts.level as pino.Level, stream: file }];
  if (opts.console) streams.push({ level: opts.level as pino.Level, stream: process.stdout });
  return pino(
    {
      level: opts.level,
      base: { app: 'mbc-backup-service', pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT, censor: '***' },
    },
    pino.multistream(streams),
  );
}

/** Logger para pruebas: escribe en un arreglo en memoria. */
export function createMemoryLogger(lines: string[] = [], level = 'debug'): Logger {
  return pino(
    { level, redact: { paths: REDACT, censor: '***' } },
    { write: (s: string) => void lines.push(s) } as unknown as pino.DestinationStream,
  );
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
