import { describe, expect, it } from 'vitest';
import { canonicalJson, computeEventHash, GENESIS_HASH } from './audit.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively and is whitespace-free', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it('is stable across key insertion order', () => {
    const one = canonicalJson({ x: 1, y: 'a', z: [true, null] });
    const two = canonicalJson({ z: [true, null], y: 'a', x: 1 });
    expect(one).toBe(two);
  });

  it('serializes BigInt as decimal string and Date as UTC ISO', () => {
    expect(canonicalJson({ seq: 42n, at: new Date('2026-08-07T12:00:00.000Z') })).toBe(
      '{"at":"2026-08-07T12:00:00.000Z","seq":"42"}',
    );
  });

  it('drops undefined object values, nullifies undefined array slots', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: [undefined] })).toBe('{"b":1,"c":[null]}');
  });

  it('refuses non-finite numbers and functions', () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
});

const baseEvent = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  sequence: 1n,
  actorUserId: 'u1',
  actorDisplay: 'Alice',
  effectiveRoles: ['reviewer'],
  action: 'tag.apply',
  targetType: 'evidence_item',
  targetId: 'e1',
  requestId: 'r1',
  ipAddress: '203.0.113.9',
  userAgent: 'test',
  summary: { tag: 'hot' },
  occurredAt: new Date('2026-08-07T12:00:00.000Z'),
};

describe('computeEventHash', () => {
  it('is deterministic', () => {
    const h1 = computeEventHash(GENESIS_HASH, baseEvent);
    const h2 = computeEventHash(GENESIS_HASH, { ...baseEvent });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any field changes', () => {
    const h = computeEventHash(GENESIS_HASH, baseEvent);
    expect(computeEventHash(GENESIS_HASH, { ...baseEvent, action: 'tag.remove' })).not.toBe(h);
    expect(computeEventHash(GENESIS_HASH, { ...baseEvent, sequence: 2n })).not.toBe(h);
    expect(computeEventHash(GENESIS_HASH, { ...baseEvent, summary: { tag: 'cold' } })).not.toBe(h);
  });

  it('chains: changing an earlier hash changes later hashes', () => {
    const h1 = computeEventHash(GENESIS_HASH, baseEvent);
    const e2 = { ...baseEvent, sequence: 2n };
    const h2 = computeEventHash(h1, e2);
    const tamperedH1 = computeEventHash(GENESIS_HASH, { ...baseEvent, actorUserId: 'mallory' });
    expect(computeEventHash(tamperedH1, e2)).not.toBe(h2);
  });
});
