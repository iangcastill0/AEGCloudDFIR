import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseCursorQuery } from './pagination.js';

const CURSOR = '01234567-89ab-4cde-8f01-23456789abcd';

describe('parseCursorQuery (audit/member list pagination)', () => {
  it('defaults to limit 50 with no cursor', () => {
    expect(parseCursorQuery({})).toEqual({ limit: 50 });
    expect(parseCursorQuery(undefined)).toEqual({ limit: 50 });
  });

  it('coerces string limits from the query string', () => {
    expect(parseCursorQuery({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('accepts the boundary values 1 and 100', () => {
    expect(parseCursorQuery({ limit: '1' })).toEqual({ limit: 1 });
    expect(parseCursorQuery({ limit: '100' })).toEqual({ limit: 100 });
  });

  it('rejects limits over 100, zero, negatives, and non-numeric', () => {
    expect(() => parseCursorQuery({ limit: '101' })).toThrow(BadRequestException);
    expect(() => parseCursorQuery({ limit: '0' })).toThrow(BadRequestException);
    expect(() => parseCursorQuery({ limit: '-5' })).toThrow(BadRequestException);
    expect(() => parseCursorQuery({ limit: 'lots' })).toThrow(BadRequestException);
    expect(() => parseCursorQuery({ limit: '2.5' })).toThrow(BadRequestException);
  });

  it('accepts a UUID cursor and rejects anything else', () => {
    expect(parseCursorQuery({ cursor: CURSOR })).toEqual({ limit: 50, cursor: CURSOR });
    expect(() => parseCursorQuery({ cursor: 'not-a-uuid' })).toThrow(BadRequestException);
    expect(() => parseCursorQuery({ cursor: '1; DROP TABLE audit_events' })).toThrow(
      BadRequestException,
    );
  });
});
