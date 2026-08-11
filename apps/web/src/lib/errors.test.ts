import { describe, expect, it } from 'vitest';
import { ApiError, errorMessage, parseErrorEnvelope } from './errors';

describe('parseErrorEnvelope', () => {
  it('parses a well-formed contract envelope', () => {
    const env = parseErrorEnvelope(
      403,
      JSON.stringify({
        statusCode: 403,
        error: 'Forbidden',
        message: 'CSRF token missing or invalid',
        requestId: 'req-123',
      }),
    );
    expect(env).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      message: 'CSRF token missing or invalid',
      requestId: 'req-123',
    });
  });

  it('normalizes Nest-style message arrays', () => {
    const env = parseErrorEnvelope(
      400,
      JSON.stringify({ statusCode: 400, message: ['name should not be empty', 'scope invalid'] }),
    );
    expect(env.message).toBe('name should not be empty; scope invalid');
    expect(env.error).toBe('Bad Request');
  });

  it('synthesizes an envelope from a non-JSON body (proxy HTML page)', () => {
    const env = parseErrorEnvelope(502, '<html>Bad gateway</html>');
    expect(env.statusCode).toBe(502);
    expect(env.error).toBe('Bad Gateway');
    expect(env.message).toContain('Bad gateway');
  });

  it('synthesizes a fallback message for an empty body', () => {
    const env = parseErrorEnvelope(500, '');
    expect(env.message).toBe('Request failed with status 500');
  });
});

describe('ApiError / errorMessage', () => {
  it('carries the envelope and appends the request id for display', () => {
    const err = new ApiError({
      statusCode: 409,
      error: 'Conflict',
      message: 'version conflict',
      requestId: 'r-9',
    });
    expect(err.statusCode).toBe(409);
    expect(errorMessage(err)).toBe('version conflict (request r-9)');
    expect(errorMessage(new Error('plain'))).toBe('plain');
    expect(errorMessage('weird')).toBe('weird');
  });
});
