import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fsyncFile } from '../util/fsx.js';

const TAIL_BYTES = 2048;

/** Transform transparente: cuenta bytes, calcula SHA-256 y conserva la cola del flujo. */
export class TapTransform extends Transform {
  bytes = 0;
  private tailBuf: Buffer = Buffer.alloc(0);
  private readonly hash: Hash = createHash('sha256');
  private hex?: string;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    this.tailBuf = Buffer.concat([this.tailBuf, chunk]).subarray(-TAIL_BYTES);
    cb(null, chunk);
  }

  get tail(): string {
    return this.tailBuf.toString('utf8');
  }

  digest(): string {
    this.hex ??= this.hash.digest('hex');
    return this.hex;
  }
}

class NullSink extends Writable {
  override _write(_chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    cb();
  }
}

export interface StreamStats {
  contentSha256: string;
  contentBytes: number;
  tail: string;
}

/** Archivo -> gzip (streaming) -> destino. Devuelve las estadísticas del contenido sin comprimir. */
export async function gzipFile(src: string, destPartial: string, level: number, signal?: AbortSignal): Promise<StreamStats> {
  const tap = new TapTransform();
  await pipeline(createReadStream(src), tap, createGzip({ level }), createWriteStream(destPartial, { flags: 'wx' }), { signal });
  await fsyncFile(destPartial);
  return { contentSha256: tap.digest(), contentBytes: tap.bytes, tail: tap.tail };
}

export interface GzipVerification extends StreamStats {
  sha256: string;
  sizeBytes: number;
}

/**
 * Lee el .gz completo en streaming: valida la estructura/CRC de GZIP, calcula el SHA-256 del archivo
 * comprimido y el del contenido descomprimido.
 */
export async function verifyGzipFile(file: string, signal?: AbortSignal): Promise<GzipVerification> {
  const compressed = new TapTransform();
  const content = new TapTransform();
  await pipeline(createReadStream(file), compressed, createGunzip(), content, new NullSink(), { signal });
  return {
    sha256: compressed.digest(),
    sizeBytes: compressed.bytes,
    contentSha256: content.digest(),
    contentBytes: content.bytes,
    tail: content.tail,
  };
}

/** Descomprime un .gz a un archivo (para restauraciones y verificación profunda). */
export async function gunzipToFile(src: string, dest: string, signal?: AbortSignal): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest, { flags: 'wx' }), { signal });
}
