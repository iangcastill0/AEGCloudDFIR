import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPLETENESS_VALUES,
  buildManifest,
  renderCompletenessReport,
  serializeManifest,
  signManifest,
  verifyManifestSignature,
  type BuildManifestInput,
} from './manifest.js';
import { sortedMerkleRoot } from './merkle.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SHA_A = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA_B = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';

function baseInput(): BuildManifestInput {
  return {
    application: {
      name: 'AEG-CloudDFIR',
      version: '0.1.0',
      parserVersions: { msg: '1.2.0', mbox: '0.9.1' },
    },
    collection: {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      tenantId: TENANT,
      name: 'Q3 Investigation',
      kind: 'mailbox',
      permissionMode: 'delegated',
      provider: 'microsoft',
      connectorLabel: 'Corp M365',
      connectorExternalIdentity: 'app-registration-1234',
      custodians: [{ id: 'c-1', email: 'jdoe@example.com', displayName: 'J. Doe' }],
      scope: { folders: ['Inbox'], from: '2024-01-01' },
      startedAt: '2026-08-01T00:00:00.000Z',
      finishedAt: '2026-08-01T02:00:00.000Z',
      apiEndpoints: ['https://graph.microsoft.com/v1.0/users/{id}/messages'],
    },
    counts: {
      discovered: 100,
      fetched: 99,
      preserved: 98,
      skipped: 1,
      errors: 1,
      providerReportedTotals: [
        { value: 102, caveat: 'Graph API folder counts include items outside the date filter' },
      ],
    },
    completeness: 'complete_with_exceptions',
    completenessNarrative: 'One item could not be fetched after 5 retries.',
    exceptions: [
      {
        kind: 'fetch_error',
        message: 'HTTP 503 after retries',
        providerItemId: 'AAMk-1',
        custodianId: 'c-1',
      },
      {
        kind: 'fetch_error',
        message: 'HTTP 410 item gone',
        providerItemId: 'AAMk-2',
        custodianId: 'c-1',
      },
      {
        kind: 'skipped_unsupported',
        message: 'IRM-protected item skipped',
        providerItemId: 'AAMk-3',
      },
    ],
    items: [
      {
        evidenceItemId: 'e-1',
        providerItemId: 'AAMk-10',
        custodianId: 'c-1',
        sha256: SHA_A,
        size: 1234,
        objectKey: `tenants/${TENANT}/originals/sha256/ba/${SHA_A}`,
        acquiredAt: '2026-08-01T00:10:00.000Z',
      },
      {
        evidenceItemId: 'e-2',
        providerItemId: 'AAMk-11',
        custodianId: 'c-1',
        sha256: SHA_B,
        size: 5678,
        objectKey: `tenants/${TENANT}/originals/sha256/b9/${SHA_B}`,
        acquiredAt: '2026-08-01T00:11:00.000Z',
        apiExportDerivative: true,
      },
    ],
  };
}

describe('buildManifest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is deterministic: same input twice produces identical bytes', () => {
    const one = serializeManifest(buildManifest(baseInput()));
    const two = serializeManifest(buildManifest(baseInput()));
    expect(one).toBe(two);
  });

  it('computes an order-independent merkle root over item hashes', () => {
    const m = buildManifest(baseInput());
    expect(m.merkleRoot).toBe(sortedMerkleRoot([SHA_A, SHA_B]));
    const reversed = baseInput();
    reversed.items.reverse();
    expect(buildManifest(reversed).merkleRoot).toBe(m.merkleRoot);
  });

  it('stamps schemaVersion and generatedAt', () => {
    const m = buildManifest(baseInput());
    expect(m.schemaVersion).toBe('1');
    expect(m.generatedAt).toBe('2026-08-07T12:00:00.000Z');
  });

  it('accepts every value of the completeness vocabulary', () => {
    for (const value of COMPLETENESS_VALUES) {
      const input = { ...baseInput(), completeness: value };
      expect(buildManifest(input).completeness).toBe(value);
    }
  });

  it("rejects absolute claims like 'complete' or 'all data'", () => {
    for (const bad of ['complete', 'all data', 'full', 'COMPLETE_WITH_EXCEPTIONS', '']) {
      const input = { ...baseInput(), completeness: bad } as unknown as BuildManifestInput;
      expect(() => buildManifest(input)).toThrow(/invalid completeness/);
    }
  });

  it('rejects items with invalid hashes or sizes', () => {
    const badHash = baseInput();
    badHash.items[0]!.sha256 = SHA_A.toUpperCase();
    expect(() => buildManifest(badHash)).toThrow(/invalid sha256/);

    const badSize = baseInput();
    badSize.items[0]!.size = -1;
    expect(() => buildManifest(badSize)).toThrow(/invalid size/);
  });
});

describe('manifest signing', () => {
  it('signs and verifies, and detects tampering', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
    const key = randomBytes(32);
    const serialized = serializeManifest(buildManifest(baseInput()));
    const sig = signManifest(serialized, key, 'key-2026-08');
    vi.useRealTimers();

    expect(sig.algorithm).toBe('HMAC-SHA256');
    expect(sig.keyId).toBe('key-2026-08');
    expect(sig.signature).toMatch(/^[0-9a-f]{64}$/);

    expect(verifyManifestSignature(serialized, sig.signature, key)).toBe(true);
    // Tampered payload
    expect(verifyManifestSignature(serialized.replace('98', '99'), sig.signature, key)).toBe(false);
    // Tampered signature
    const flipped = (sig.signature[0] === 'a' ? 'b' : 'a') + sig.signature.slice(1);
    expect(verifyManifestSignature(serialized, flipped, key)).toBe(false);
    // Wrong key
    expect(verifyManifestSignature(serialized, sig.signature, randomBytes(32))).toBe(false);
    // Malformed signature strings never throw
    expect(verifyManifestSignature(serialized, 'not-hex', key)).toBe(false);
    expect(verifyManifestSignature(serialized, '', key)).toBe(false);
  });

  it('rejects an empty signing key', () => {
    expect(() => signManifest('{}', Buffer.alloc(0))).toThrow(TypeError);
  });
});

describe('renderCompletenessReport', () => {
  it('contains counts, grouped exceptions, and honest scope wording', () => {
    const report = renderCompletenessReport(buildManifest(baseInput()));

    expect(report).toContain('discovered: 100');
    expect(report).toContain('preserved:  98');
    expect(report).toContain('errors:     1');
    expect(report).toContain('provider-reported total: 102');

    expect(report).toContain('Exceptions: 3');
    expect(report).toContain('fetch_error: 2');
    expect(report).toContain('skipped_unsupported: 1');

    expect(report).toContain('complete_with_exceptions');
    expect(report).toContain('with documented exceptions');
    expect(report).toContain(
      'items returned within the selected account, permissions, API-visible scope, retention state, and provider limitations',
    );
    // Never an unqualified absolute claim on its own line.
    expect(report).not.toMatch(/^Completeness: complete$/m);
  });

  it('handles zero exceptions honestly', () => {
    const input = {
      ...baseInput(),
      exceptions: [],
      completeness: 'complete_within_selected_api_scope' as const,
    };
    const report = renderCompletenessReport(buildManifest(input));
    expect(report).toContain('Exceptions: 0');
    expect(report).toContain('(none recorded)');
    expect(report).toContain('Complete within the selected API scope');
  });
});
