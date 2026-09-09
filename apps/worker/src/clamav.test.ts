import { createServer, type Server, type Socket as NetSocket } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamdClient } from './clamav.js';

/**
 * Real sockets, not mocks. The bug these cover lived entirely in the timing
 * between two streams, and a mocked socket has no timing to get wrong.
 */

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/**
 * Start a stand-in clamd that actually frames INSTREAM.
 *
 * TCP does not preserve write boundaries: the four-byte terminator arrives
 * glued to the chunk before it as often as not. So the fake buffers and reads
 * real length prefixes, the way clamd does, instead of guessing from packet
 * sizes.
 *
 * `onFrame` is called per payload frame and may answer early; `onEnd` fires on
 * the zero-length terminator.
 */
async function clamd(opts: {
  onFrame?: (socket: NetSocket, bytesSeen: number) => void;
  onEnd?: (socket: NetSocket) => void;
}): Promise<number> {
  const s = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let started = false;
    let payloadSeen = 0;
    let done = false;

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!started) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        started = true;
        buf = buf.subarray(nul + 1);
      }
      while (!done && buf.byteLength >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          buf = buf.subarray(4);
          done = true;
          opts.onEnd?.(socket);
          return;
        }
        if (buf.byteLength < 4 + len) return;
        buf = buf.subarray(4 + len);
        payloadSeen += len;
        opts.onFrame?.(socket, payloadSeen);
      }
    });
    // A client that gives up mid-scan must not take the test process with it.
    socket.on('error', () => undefined);
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const addr = s.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

/** Big enough to span many 64 KiB chunks, so an early reply lands mid-write. */
function bigStream(bytes: number): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= bytes) {
        this.push(null);
        return;
      }
      const size = Math.min(64 * 1024, bytes - sent);
      sent += size;
      this.push(Buffer.alloc(size, 0x41));
    },
  });
}

describe('ClamdClient.scanStream', () => {
  it('reads a clean verdict', async () => {
    const port = await clamd({
      onEnd: (socket) => socket.write('stream: OK\0'),
    });
    const result = await new ClamdClient('127.0.0.1', port, 5000).scanStream(
      Readable.from([Buffer.from('harmless')]),
    );
    expect(result).toEqual({ infected: false, signature: '' });
  });

  it('reads a signature hit', async () => {
    const port = await clamd({
      onEnd: (socket) => socket.write('stream: Eicar-Test-Signature FOUND\0'),
    });
    const result = await new ClamdClient('127.0.0.1', port, 5000).scanStream(
      Readable.from([Buffer.from('x')]),
    );
    expect(result).toEqual({ infected: true, signature: 'Eicar-Test-Signature' });
  });

  it('survives clamd answering in the middle of the upload', async () => {
    // The crash. clamd aborts a long stream (signature hit, or INSTREAM size
    // limit exceeded) and answers early; readReply ends our side of the socket
    // the moment it sees that reply; the write loop is still going and the next
    // chunk throws ERR_STREAM_WRITE_AFTER_END. The reply promise — created
    // before the loop, awaited after it — was left floating, and the unhandled
    // rejection killed the whole worker process.
    let answered = false;
    const port = await clamd({
      onFrame: (socket, seen) => {
        if (!answered && seen > 128 * 1024) {
          answered = true;
          socket.write('stream: Eicar-Test-Signature FOUND\0');
        }
      },
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const client = new ClamdClient('127.0.0.1', port, 5000);
      // Either a verdict or a thrown scan error is acceptable here. Killing the
      // process is not, and that is what this asserts.
      await client.scanStream(bigStream(8 * 1024 * 1024)).catch(() => undefined);
      // Unhandled rejections are reported on a later turn of the loop.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('does not leave an unhandled rejection when clamd hangs up mid-scan', async () => {
    // The other shape of the same fault: the far end vanishes (EPIPE / ECONNRESET)
    // rather than replying. Seen in production as `scan: clamav unavailable —
    // write EPIPE` immediately before the process died.
    const port = await clamd({
      onFrame: (socket, seen) => {
        if (seen > 128 * 1024) socket.destroy();
      },
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await new ClamdClient('127.0.0.1', port, 5000)
        .scanStream(bigStream(8 * 1024 * 1024))
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});
