import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { zodValidate } from './zod-validate.js';

const schema = z.object({
  name: z.string().min(1),
  count: z.number().int().min(1),
  nested: z.object({ flag: z.boolean() }),
});

describe('zodValidate', () => {
  it('returns parsed data (with defaults applied) on success', () => {
    const withDefault = z.object({ a: z.string(), b: z.number().default(7) });
    expect(zodValidate(withDefault, { a: 'x' })).toEqual({ a: 'x', b: 7 });
  });

  it('throws BadRequest with a full issue list including nested paths', () => {
    let caught: BadRequestException | undefined;
    try {
      zodValidate(schema, { name: '', count: 0, nested: { flag: 'nope' } });
    } catch (err) {
      caught = err as BadRequestException;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const response = caught?.getResponse() as {
      message: string;
      issues: { path: string; message: string }[];
    };
    expect(response.message).toBe('validation failed');
    expect(response.issues.length).toBe(3);
    const paths = response.issues.map((issue) => issue.path);
    expect(paths).toContain('name');
    expect(paths).toContain('count');
    expect(paths).toContain('nested.flag');
    for (const issue of response.issues) {
      expect(typeof issue.message).toBe('string');
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-object bodies', () => {
    expect(() => zodValidate(schema, undefined)).toThrow(BadRequestException);
    expect(() => zodValidate(schema, 'text')).toThrow(BadRequestException);
  });
});
