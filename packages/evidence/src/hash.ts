import { createHash } from 'node:crypto';
import { Transform, Writable, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Pass-through Transform stream that updates a SHA-256 digest and byte count
 * as bytes flow through it. Bytes are never buffered beyond the chunk in
 * flight, so arbitrarily large payloads can be hashed while streaming.
 *
 * `digestHex()` and `bytesSeen` are valid once the stream has finished
 * (flushed); calling `digestHex()` earlier throws.
 */
export class Sha256Stream extends Transform {
  private readonly hash = createHash('sha256');
  private bytes = 0;
  private digest: string | null = null;

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
    this.hash.update(buf);
    this.bytes += buf.byteLength;
    callback(null, buf);
  }

  override _flush(callback: TransformCallback): void {
    this.digest = this.hash.digest('hex');
    callback();
  }

  /** Lowercase hex SHA-256 of all bytes seen. Only valid after the stream finished. */
  digestHex(): string {
    if (this.digest === null) {
      throw new Error('Sha256Stream: digest requested before the stream finished');
    }
    return this.digest;
  }

  /** Total number of bytes that flowed through the stream so far. */
  get bytesSeen(): number {
    return this.bytes;
  }
}

/** SHA-256 of an in-memory buffer, as lowercase hex. */
export function hashBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Consume a readable stream entirely (discarding bytes) while hashing it.
 * Returns the SHA-256 hex digest and total size without buffering the payload.
 */
export async function hashStreamToNull(
  readable: Readable,
): Promise<{ sha256: string; size: number }> {
  const hasher = new Sha256Stream();
  const devNull = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  await pipeline(readable, hasher, devNull);
  return { sha256: hasher.digestHex(), size: hasher.bytesSeen };
}
