import { describe, expect, it } from 'vitest';
import { DEFAULT_FIELD_REGISTRY, FieldRegistry } from './fields.js';
import { buildAliasName, buildIndexName, EVIDENCE_MAPPING, MAPPING_VERSION } from './mapping.js';

describe('index naming', () => {
  it('builds versioned index names and stable alias names', () => {
    expect(MAPPING_VERSION).toBe(2);
    expect(buildIndexName('ev', 1)).toBe('ev-evidence-v1');
    expect(buildIndexName('ev', 2)).toBe('ev-evidence-v2');
    expect(buildAliasName('ev')).toBe('ev-evidence');
  });
});

describe('EVIDENCE_MAPPING', () => {
  const properties = EVIDENCE_MAPPING.mappings.properties as Record<
    string,
    Record<string, unknown>
  >;

  it('caps the result window and defines the folded analyzer + lowercase normalizer', () => {
    expect(EVIDENCE_MAPPING.settings.index.max_result_window).toBe(10000);
    expect(EVIDENCE_MAPPING.settings.analysis.analyzer.folded.filter).toContain('asciifolding');
    expect(EVIDENCE_MAPPING.settings.analysis.normalizer.lowercase_normalizer.filter).toContain(
      'lowercase',
    );
  });

  it('rejects unmapped fields (dynamic strict)', () => {
    expect(EVIDENCE_MAPPING.mappings.dynamic).toBe('strict');
  });

  it('maps identity and filter fields as keywords', () => {
    for (const field of ['evidenceItemId', 'tenantId', 'kind', 'caseIds', 'provider']) {
      expect(properties[field], field).toMatchObject({ type: 'keyword' });
    }
    expect(properties['sha256']).toMatchObject({
      type: 'keyword',
      normalizer: 'lowercase_normalizer',
    });
  });

  it('maps name and subject as text with a keyword multi-field', () => {
    expect(properties['name']).toMatchObject({
      type: 'text',
      fields: { keyword: { type: 'keyword' } },
    });
    const email = properties['email'] as { properties: Record<string, unknown> };
    expect(email.properties['subject']).toMatchObject({
      type: 'text',
      analyzer: 'english',
      fields: { keyword: { type: 'keyword' } },
    });
  });

  it('uses the english analyzer for all extracted text', () => {
    const text = properties['text'] as { properties: Record<string, unknown> };
    for (const field of ['body', 'bodyHtml', 'attachment', 'file', 'ocr']) {
      expect(text.properties[field], field).toEqual({ type: 'text', analyzer: 'english' });
    }
  });

  it('maps headers, ocrPages, tags and bates as nested', () => {
    for (const field of ['headers', 'ocrPages', 'tags', 'bates']) {
      expect(properties[field], field).toMatchObject({ type: 'nested' });
    }
    const headers = properties['headers'] as { properties: Record<string, unknown> };
    expect(headers.properties['name']).toMatchObject({ normalizer: 'lowercase_normalizer' });
  });

  it('maps every date strictly (ignore_malformed false)', () => {
    const dates = properties['dates'] as { properties: Record<string, Record<string, unknown>> };
    for (const field of ['sent', 'received', 'created', 'modified', 'acquired', 'primary']) {
      expect(dates.properties[field], field).toEqual({ type: 'date', ignore_malformed: false });
    }
  });

  it('maps email addresses with lowercase keyword address + domain', () => {
    const email = properties['email'] as { properties: Record<string, unknown> };
    for (const field of ['from', 'sender', 'to', 'cc', 'bcc', 'replyTo']) {
      expect(email.properties[field], field).toMatchObject({
        properties: {
          address: { type: 'keyword', normalizer: 'lowercase_normalizer' },
          domain: { type: 'keyword', normalizer: 'lowercase_normalizer' },
        },
      });
    }
  });

  it('maps size as long', () => {
    expect(properties['size']).toEqual({ type: 'long' });
  });
});

describe('FieldRegistry', () => {
  it('exposes the documented user-facing fields', () => {
    const allowed = DEFAULT_FIELD_REGISTRY.allowedFields();
    for (const field of [
      'from',
      'to',
      'cc',
      'bcc',
      'sender',
      'replyto',
      'participants',
      'subject',
      'body',
      'text',
      'attachment',
      'ocr',
      'filename',
      'name',
      'extension',
      'ext',
      'mime',
      'mimetype',
      'path',
      'folder',
      'label',
      'labels',
      'source',
      'hash',
      'sha256',
      'custodian',
      'provider',
      'tag',
      'tags',
      'case',
      'messageid',
      'threadid',
      'privileged',
      'confidential',
      'produced',
      'bates',
      'size',
      'sent',
      'received',
      'created',
      'modified',
      'acquired',
      'date',
      'header.<name>',
    ]) {
      expect(allowed, field).toContain(field);
    }
  });

  it('does not expose tenantId or caseIds document paths', () => {
    const allowed = DEFAULT_FIELD_REGISTRY.allowedFields();
    expect(allowed).not.toContain('tenantid');
    expect(allowed).not.toContain('tenantId');
    expect(allowed).not.toContain('caseids');
  });

  it('supports custom registries', () => {
    const registry = new FieldRegistry({ only: { esPath: 'name', type: 'text' } });
    expect(registry.resolve('ONLY')).toEqual({ name: 'only', esPath: 'name', type: 'text' });
    expect(() => registry.resolve('from')).toThrow(/Unknown field/);
  });
});
