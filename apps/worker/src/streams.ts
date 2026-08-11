import type { Readable } from 'node:stream';

export class PayloadTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`payload exceeds the ${limitBytes} byte processing limit`);
    this.name = 'PayloadTooLargeError';
  }
}

/** Buffer a readable fully, throwing once it exceeds `limitBytes`. */
export async function readAllCapped(readable: Readable, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of readable) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > limitBytes) {
      readable.destroy();
      throw new PayloadTooLargeError(limitBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
