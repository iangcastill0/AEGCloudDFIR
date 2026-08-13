import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  parseUploadResponse,
  startUpload,
  uploadProgressFraction,
  type UploadProgressEvent,
  type UploadXhrLike,
} from './api';
import { CSRF_HEADER_NAME } from './csrf';
import { ApiError } from './errors';

const uploadSchema = z.object({
  uploadId: z.string(),
  filename: z.string(),
  sha256: z.string(),
  size: z.number(),
});

const OK_BODY = JSON.stringify({
  uploadId: 'up-1',
  filename: 'mailbox.pst',
  sha256: 'a'.repeat(64),
  size: 1024,
});

describe('uploadProgressFraction', () => {
  it('maps loaded/total to a 0..1 fraction', () => {
    expect(uploadProgressFraction({ lengthComputable: true, loaded: 0, total: 200 })).toBe(0);
    expect(uploadProgressFraction({ lengthComputable: true, loaded: 50, total: 200 })).toBe(0.25);
    expect(uploadProgressFraction({ lengthComputable: true, loaded: 200, total: 200 })).toBe(1);
  });

  it('clamps overshoot into 0..1', () => {
    expect(uploadProgressFraction({ lengthComputable: true, loaded: 300, total: 200 })).toBe(1);
    expect(uploadProgressFraction({ lengthComputable: true, loaded: -5, total: 200 })).toBe(0);
  });

  it('returns null when the event is indeterminate', () => {
    expect(uploadProgressFraction({ lengthComputable: false, loaded: 10, total: 100 })).toBeNull();
    expect(uploadProgressFraction({ lengthComputable: true, loaded: 10, total: 0 })).toBeNull();
  });
});

describe('parseUploadResponse', () => {
  it('parses a 2xx JSON body with the schema', () => {
    const parsed = parseUploadResponse(201, OK_BODY, uploadSchema);
    expect(parsed.uploadId).toBe('up-1');
    expect(parsed.size).toBe(1024);
  });

  it('maps a standard error envelope to ApiError', () => {
    const envelope = JSON.stringify({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'only .pst and .ost files are accepted',
      requestId: 'req-9',
    });
    let thrown: unknown;
    try {
      parseUploadResponse(422, envelope, uploadSchema);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const apiError = thrown as ApiError;
    expect(apiError.statusCode).toBe(422);
    expect(apiError.errorCode).toBe('Unprocessable Entity');
    expect(apiError.message).toBe('only .pst and .ost files are accepted');
    expect(apiError.requestId).toBe('req-9');
  });

  it('synthesizes an envelope from a non-JSON error body', () => {
    expect(() => parseUploadResponse(502, '<html>bad gateway</html>', uploadSchema)).toThrowError(
      ApiError,
    );
    try {
      parseUploadResponse(502, '<html>bad gateway</html>', uploadSchema);
    } catch (err) {
      expect((err as ApiError).errorCode).toBe('Bad Gateway');
    }
  });

  it('rejects a 2xx body that is not JSON', () => {
    expect(() => parseUploadResponse(200, 'ok', uploadSchema)).toThrowError(ApiError);
  });

  it('rejects a 2xx body that fails schema validation', () => {
    expect(() => parseUploadResponse(200, JSON.stringify({ nope: true }), uploadSchema)).toThrow();
  });
});

/** Minimal scriptable stand-in for XMLHttpRequest. */
class FakeXhr implements UploadXhrLike {
  withCredentials = false;
  status = 0;
  responseText = '';
  opened: { method: string; url: string } | null = null;
  headers: Record<string, string> = {};
  sentBody: FormData | null = null;
  private readonly listeners: Record<'load' | 'error', Array<() => void>> = {
    load: [],
    error: [],
  };
  private readonly progressListeners: Array<(event: UploadProgressEvent) => void> = [];

  upload = {
    addEventListener: (_type: 'progress', listener: (event: UploadProgressEvent) => void): void => {
      this.progressListeners.push(listener);
    },
  };

  addEventListener(type: 'load' | 'error', listener: () => void): void {
    this.listeners[type].push(listener);
  }

  open(method: string, url: string): void {
    this.opened = { method, url };
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: FormData): void {
    this.sentBody = body;
  }

  emitProgress(event: UploadProgressEvent): void {
    for (const listener of this.progressListeners) listener(event);
  }

  respond(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    for (const listener of this.listeners.load) listener();
  }

  failNetwork(): void {
    for (const listener of this.listeners.error) listener();
  }
}

function testFile(): File {
  return new File(['pst-bytes'], 'mailbox.pst', { type: 'application/octet-stream' });
}

describe('startUpload', () => {
  it('POSTs the file as multipart field "file" with credentials and CSRF header', async () => {
    const xhr = new FakeXhr();
    const promise = startUpload(xhr, {
      url: 'http://localhost:4000/api/v1/uploads',
      csrfToken: 'csrf-token-1',
      file: testFile(),
      schema: uploadSchema,
    });
    expect(xhr.opened).toEqual({ method: 'POST', url: 'http://localhost:4000/api/v1/uploads' });
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers[CSRF_HEADER_NAME]).toBe('csrf-token-1');
    const part = xhr.sentBody?.get('file');
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe('mailbox.pst');

    xhr.respond(200, OK_BODY);
    await expect(promise).resolves.toMatchObject({ uploadId: 'up-1', filename: 'mailbox.pst' });
  });

  it('reports monotone 0..1 progress and skips indeterminate events', async () => {
    const xhr = new FakeXhr();
    const fractions: number[] = [];
    const promise = startUpload(xhr, {
      url: 'http://x/api/v1/uploads',
      csrfToken: 't',
      file: testFile(),
      schema: uploadSchema,
      onProgress: (fraction) => fractions.push(fraction),
    });
    xhr.emitProgress({ lengthComputable: true, loaded: 0, total: 100 });
    xhr.emitProgress({ lengthComputable: false, loaded: 50, total: 0 });
    xhr.emitProgress({ lengthComputable: true, loaded: 50, total: 100 });
    xhr.emitProgress({ lengthComputable: true, loaded: 100, total: 100 });
    xhr.respond(200, OK_BODY);
    await promise;
    expect(fractions).toEqual([0, 0.5, 1]);
  });

  it('rejects with the parsed error envelope on a non-2xx response', async () => {
    const xhr = new FakeXhr();
    const promise = startUpload(xhr, {
      url: 'http://x/api/v1/uploads',
      csrfToken: 't',
      file: testFile(),
      schema: uploadSchema,
    });
    xhr.respond(
      413,
      JSON.stringify({ statusCode: 413, error: 'Payload Too Large', message: 'file too large' }),
    );
    await expect(promise).rejects.toMatchObject({
      name: 'ApiError',
      statusCode: 413,
      message: 'file too large',
    });
  });

  it('rejects with a network ApiError when the transport fails', async () => {
    const xhr = new FakeXhr();
    const promise = startUpload(xhr, {
      url: 'http://x/api/v1/uploads',
      csrfToken: 't',
      file: testFile(),
      schema: uploadSchema,
    });
    xhr.failNetwork();
    await expect(promise).rejects.toMatchObject({ name: 'ApiError', statusCode: 0 });
  });
});
