import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import {
  buildProductionManifest,
  type ProductionManifestInput,
} from './manifest.js';
import type { ProducedItemRecord } from './types.js';

function record(begBates: string): ProducedItemRecord {
  return {
    begBates,
    endBates: begBates,
    begAttach: null,
    endAttach: null,
    custodian: 'Smith',
    sourcePath: null,
    fileName: 'a.pdf',
    extension: 'pdf',
    mime: 'application/pdf',
    sha256: 'ab'.repeat(32),
    from: null,
    to: null,
    cc: null,
    bcc: null,
    subject: null,
    sentDate: null,
    receivedDate: null,
    dateCreated: null,
    dateModified: null,
    textPath: null,
    nativePath: null,
    tags: ['Hot'],
  };
}

function input(): ProductionManifestInput {
  return {
    runId: 'run-1',
    productionId: 'prod-1',
    parameters: { name: 'Wave 1', sort: 'folder_filename', bates: { prefix: 'ABC' } },
    items: [
      {
        ...record('ABC00000001'),
        sha256PerOutput: [
          { path: 'IMAGES/VOL001/ABC00000001.tif', sha256: 'cd'.repeat(32), size: 4096 },
        ],
      },
    ],
    exceptions: [{ evidenceId: 'ev-9', reason: 'unsupported_conversion' }],
    batesStart: 'ABC00000001',
    batesEnd: 'ABC00000001',
    generatedAt: '2026-08-10T00:00:00.000Z',
  };
}

describe('canonicalJson', () => {
  it('sorts keys recursively with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 0, y: 1 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[1,{"y":1,"z":0}]},"b":1}',
    );
  });

  it('drops undefined object properties and nullifies undefined array slots', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it('throws on non-finite numbers', () => {
    expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError);
  });
});

describe('buildProductionManifest', () => {
  it('is deterministic across runs with a fixed generatedAt', () => {
    const first = buildProductionManifest(input());
    const second = buildProductionManifest(input());
    expect(first.json).toBe(second.json);
    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is insensitive to key insertion order in parameters', () => {
    const reordered = input();
    reordered.parameters = { bates: { prefix: 'ABC' }, sort: 'folder_filename', name: 'Wave 1' };
    expect(buildProductionManifest(reordered).sha256).toBe(buildProductionManifest(input()).sha256);
  });

  it('accepts a Date for generatedAt and normalizes to ISO', () => {
    const withDate = input();
    withDate.generatedAt = new Date('2026-08-10T00:00:00.000Z');
    expect(buildProductionManifest(withDate).sha256).toBe(buildProductionManifest(input()).sha256);
  });

  it('changes the hash on any mutation', () => {
    const base = buildProductionManifest(input()).sha256;

    const differentBates = input();
    differentBates.batesEnd = 'ABC00000002';
    expect(buildProductionManifest(differentBates).sha256).not.toBe(base);

    const differentItemHash = input();
    const item = differentItemHash.items[0];
    if (item?.sha256PerOutput[0]) item.sha256PerOutput[0].sha256 = 'ef'.repeat(32);
    expect(buildProductionManifest(differentItemHash).sha256).not.toBe(base);

    const differentTime = input();
    differentTime.generatedAt = '2026-08-10T00:00:01.000Z';
    expect(buildProductionManifest(differentTime).sha256).not.toBe(base);

    const differentExceptions = input();
    differentExceptions.exceptions = [];
    expect(buildProductionManifest(differentExceptions).sha256).not.toBe(base);
  });

  it('json is canonical: parsing and re-canonicalizing is identity', () => {
    const { json } = buildProductionManifest(input());
    expect(canonicalJson(JSON.parse(json))).toBe(json);
  });
});
