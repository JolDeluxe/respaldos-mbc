export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'LIVE_BLOCKED'
  | 'LOCK_HELD'
  | 'PATH_ESCAPE'
  | 'TOOL_MISSING'
  | 'TOOL_FAILED'
  | 'INSUFFICIENT_DISK'
  | 'VALIDATION_FAILED'
  | 'ABORTED'
  | 'CONNECTION_FAILED'
  | 'SOURCE_MISSING'
  | 'UNSAFE_NAME'
  | 'NODE_VERSION';

export class BackupError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BackupError';
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof BackupError && err.code === 'ABORTED') ||
    (err instanceof Error && (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR'))
  );
}

/** Mensaje seguro (sin ruido de pila) para registros. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
