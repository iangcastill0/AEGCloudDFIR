import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it('is deterministic regardless of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 'a', z: [true, null] })).toBe(
      canonicalJson({ z: [true, null], y: 'a', x: 1 }),
    );
  });

  it('serializes BigInt as decimal string and Date as ISO UTC', () => {
    expect(canonicalJson({ seq: 42n, at: new Date('2026-08-07T12:00:00.000Z') })).toBe(
      '{"at":"2026-08-07T12:00:00.000Z","seq":"42"}',
    );
  });

  it('drops undefined in objects and nulls it in arrays', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: [undefined, 2] })).toBe('{"b":1,"c":[null,2]}');
  });

  it('throws on non-finite numbers and functions', () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
});
