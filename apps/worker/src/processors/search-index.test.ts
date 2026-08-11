import { describe, expect, it } from 'vitest';
import { MAX_HEADERS_INDEXED, buildSearchDoc, type SearchDocInput } from './search-index.js';

const base: SearchDocInput = {
  evidenceItemId: 'ev-1',
  tenantId: 't-1',
  kind: 'email',
  name: 'Hello',
  extension: 'eml',
  mimeType: 'message/rfc822',
  size: 10,
  sha256: 'a'.repeat(64),
  custodianId: 'c-1',
  custodianEmail: 'user@example.com',
  provider: 'microsoft',
  collectionId: 'col-1',
  sourcePath: '/Inbox',
  sourceLabels: [],
  processingStatus: 'parsed',
  malwareStatus: 'clean',
  primaryDate: new Date('2026-02-01T10:00:00Z'),
  acquiredAt: new Date('2026-02-02T10:00:00Z'),
  sourceCreatedAt: null,
  sourceModifiedAt: null,
  email: {
    subject: 'Hello',
    messageId: '<m1@x>',
    inReplyTo: '',
    references: [],
    threadId: 'th-1',
    folder: 'Inbox',
    bccPresent: false,
    sentAt: new Date('2026-02-01T09:59:00Z'),
    receivedAt: new Date('2026-02-01T10:00:00Z'),
  },
  participants: [
    { role: 'from', rawName: 'A', rawAddress: 'a@x.com', normalizedAddress: 'a@x.com', domain: 'x.com' },
    { role: 'to', rawName: '', rawAddress: 'b@y.com', normalizedAddress: 'b@y.com', domain: 'y.com' },
    {
      role: 'bcc',
      rawName: '',
      rawAddress: 'hidden@z.com',
      normalizedAddress: 'hidden@z.com',
      domain: 'z.com',
    },
  ],
  headers: [{ rawName: 'X-One', value: '1' }],
  texts: { body: 'hello body' },
  ocrPages: [],
  tags: [],
  caseIds: [],
  bates: [],
  familyId: null,
  parentId: null,
  isFamilyChild: false,
};

describe('buildSearchDoc', () => {
  it('never emits bcc addresses unless bccPresent is genuinely true', () => {
    const withoutBcc = buildSearchDoc(base);
    expect(withoutBcc.email?.bcc).toBeUndefined();
    expect(withoutBcc.email?.bccPresent).toBe(false);

    const withBcc = buildSearchDoc({
      ...base,
      email: { ...(base.email as NonNullable<SearchDocInput['email']>), bccPresent: true },
    });
    expect(withBcc.email?.bccPresent).toBe(true);
    expect(withBcc.email?.bcc).toEqual([{ address: 'hidden@z.com', domain: 'z.com' }]);
  });

  it('caps indexed headers at the limit', () => {
    const headers = Array.from({ length: 400 }, (_, i) => ({
      rawName: `X-H-${i}`,
      value: String(i),
    }));
    const doc = buildSearchDoc({ ...base, headers });
    expect(doc.headers).toHaveLength(MAX_HEADERS_INDEXED);
    expect(doc.headers?.[0]?.name).toBe('X-H-0');
  });

  it('maps tags, cases, bates, and derived privilege flags', () => {
    const doc = buildSearchDoc({
      ...base,
      tags: [
        { id: 't1', name: 'Privileged', isPrivileged: true, isConfidential: false },
        { id: 't2', name: 'Hot', isPrivileged: false, isConfidential: true },
      ],
      caseIds: ['case-1', 'case-2'],
      bates: [
        { productionId: 'p1', productionName: 'Prod 1', begBates: 'ABC000001', endBates: 'ABC000003' },
      ],
    });
    expect(doc.tagNames).toEqual(['Privileged', 'Hot']);
    expect(doc.privileged).toBe(true);
    expect(doc.confidential).toBe(true);
    expect(doc.caseIds).toEqual(['case-1', 'case-2']);
    expect(doc.bates?.[0]?.begBates).toBe('ABC000001');
    expect(doc.hasBeenProduced).toBe(true);
  });

  it('collects normalized addresses and domains across all roles', () => {
    const doc = buildSearchDoc(base);
    expect(doc.addresses?.all).toEqual(['a@x.com', 'b@y.com', 'hidden@z.com']);
    expect(doc.addresses?.domains).toEqual(['x.com', 'y.com', 'z.com']);
  });

  it('uses the acquisition date as the primary-date fallback', () => {
    const doc = buildSearchDoc({ ...base, primaryDate: null });
    expect(doc.dates.primary).toBe('2026-02-02T10:00:00.000Z');
  });
});
