import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { UnhandledErrorFilter, describeError, statusFor } from './error-filter.js';

function host(): {
  host: ArgumentsHost;
  sent: { status?: number; body?: unknown };
} {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  const request = {
    method: 'POST',
    url: '/api/v1/productions/x/validate?code=SECRETCODE',
    id: 'req-1',
  };
  return {
    host: {
      switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
    } as unknown as ArgumentsHost,
    sent,
  };
}

describe('UnhandledErrorFilter', () => {
  it('logs the error behind a 500, which is what was missing entirely', () => {
    // A production failed with a bare "statusCode":500 and nothing at level 40
    // or 50 anywhere in the log. Finding the cause took reading source.
    const logger = { error: vi.fn() };
    const { host: h } = host();
    new UnhandledErrorFilter(logger).catch(new Error('bind parameters exceeded'), h);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload] = logger.error.mock.calls[0] ?? [];
    expect((payload as { err: { message: string } }).err.message).toBe('bind parameters exceeded');
    expect((payload as { err: { stack?: string } }).err.stack).toBeDefined();
  });

  it('records which request failed, so the log line is actionable', () => {
    const logger = { error: vi.fn() };
    const { host: h } = host();
    new UnhandledErrorFilter(logger).catch(new Error('boom'), h);
    const [payload] = logger.error.mock.calls[0] ?? [];
    const req = (payload as { req: { url: string; method: string; requestId: string } }).req;
    expect(req.url).toContain('/validate');
    // An error on a callback must not log the credential either.
    expect(req.url).not.toContain('SECRETCODE');
    expect(req.method).toBe('POST');
    expect(req.requestId).toBe('req-1');
  });

  it('never sends the internal message to the browser', () => {
    // Internal messages carry table names, ids and query fragments.
    const { host: h, sent } = host();
    new UnhandledErrorFilter({ error: vi.fn() }).catch(new Error('relation "x" does not exist'), h);
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain('relation');
    expect(sent.body).toEqual({ statusCode: 500, message: 'Internal server error' });
  });

  it('does not log a 4xx, which is the API working as designed', () => {
    // Logging every bad request as an error would bury the 500s.
    const logger = { error: vi.fn() };
    const { host: h, sent } = host();
    new UnhandledErrorFilter(logger).catch(new BadRequestException('missing field'), h);
    expect(logger.error).not.toHaveBeenCalled();
    expect(sent.status).toBe(400);
  });

  it('logs a deliberate 500 too', () => {
    const logger = { error: vi.fn() };
    const { host: h } = host();
    new UnhandledErrorFilter(logger).catch(new InternalServerErrorException('nope'), h);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('keeps the client response an HttpException already chose', () => {
    const { host: h, sent } = host();
    new UnhandledErrorFilter({ error: vi.fn() }).catch(new BadRequestException('missing field'), h);
    expect(JSON.stringify(sent.body)).toContain('missing field');
  });
});

describe('describeError', () => {
  it('reads a thrown string rather than logging [object Object]', () => {
    expect(describeError('plain failure').message).toBe('plain failure');
  });

  it('reads a thrown object', () => {
    expect(describeError({ code: 'P2002' }).message).toContain('P2002');
  });

  it('survives a value that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });
});

describe('statusFor', () => {
  it('treats anything unrecognised as a 500', () => {
    expect(statusFor(new Error('x'))).toBe(500);
    expect(statusFor('x')).toBe(500);
  });

  it('respects an HttpException status', () => {
    expect(statusFor(new BadRequestException())).toBe(400);
  });
});
