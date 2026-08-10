import { describe, expect, it } from 'vitest';
import { KeyValidationError } from './errors.js';
import {
  assertKeyInTenant,
  derivativeKey,
  exportKey,
  keyClass,
  manifestKey,
  originalKey,
  productionKey,
  quarantineKey,
  sanitizeFilename,
  stagingKey,
} from './objectKeys.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUN = '99999999-8888-4777-8666-555555555555';
const SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const NUL = String.fromCharCode(0);

describe('key builders', () => {
  it('builds a staging key', () => {
    expect(stagingKey(TENANT, ID)).toBe(`tenants/${TENANT}/staging/${ID}`);
  });

  it('builds an original key with first2 prefix', () => {
    expect(originalKey(TENANT, SHA)).toBe(`tenants/${TENANT}/originals/sha256/ba/${SHA}`);
  });

  it('builds a quarantine key with first2 prefix', () => {
    expect(quarantineKey(TENANT, SHA)).toBe(`tenants/${TENANT}/quarantine/sha256/ba/${SHA}`);
  });

  it('builds a derivative key', () => {
    expect(derivativeKey(TENANT, ID, 'text', 2, 'extracted.txt')).toBe(
      `tenants/${TENANT}/derivatives/${ID}/text/2/extracted.txt`,
    );
  });

  it('builds a manifest key', () => {
    expect(manifestKey(TENANT, ID)).toBe(`tenants/${TENANT}/manifests/${ID}/manifest.json`);
  });

  it('builds a production key with parts', () => {
    expect(productionKey(TENANT, ID, RUN, 'natives', 'DOC-000001.msg')).toBe(
      `tenants/${TENANT}/productions/${ID}/${RUN}/natives/DOC-000001.msg`,
    );
  });

  it('builds an export key with parts', () => {
    expect(exportKey(TENANT, ID, 'archive.zip')).toBe(`tenants/${TENANT}/exports/${ID}/archive.zip`);
  });

  it('rejects malformed UUIDs', () => {
    expect(() => stagingKey('not-a-uuid', ID)).toThrow(KeyValidationError);
    expect(() => stagingKey(TENANT, 'nope')).toThrow(TypeError);
    expect(() => originalKey(ID.toUpperCase(), SHA)).toThrow(KeyValidationError);
    expect(() => manifestKey(TENANT, `${ID}x`)).toThrow(KeyValidationError);
    expect(() => productionKey(TENANT, ID, 'run-1', 'a')).toThrow(KeyValidationError);
  });

  it('rejects uppercase or malformed sha256', () => {
    expect(() => originalKey(TENANT, SHA.toUpperCase())).toThrow(KeyValidationError);
    expect(() => originalKey(TENANT, SHA.slice(0, 63))).toThrow(KeyValidationError);
    expect(() => quarantineKey(TENANT, `${SHA.slice(0, 63)}g`)).toThrow(KeyValidationError);
  });

  it('rejects invalid derivative type and version', () => {
    expect(() => derivativeKey(TENANT, ID, 'Bad Type', 1, 'a.txt')).toThrow(KeyValidationError);
    expect(() => derivativeKey(TENANT, ID, 'text', 1.5, 'a.txt')).toThrow(KeyValidationError);
    expect(() => derivativeKey(TENANT, ID, 'text', -1, 'a.txt')).toThrow(KeyValidationError);
  });

  it('rejects injection attempts in production/export parts', () => {
    expect(() => productionKey(TENANT, ID, RUN, '..')).toThrow(KeyValidationError);
    expect(() => productionKey(TENANT, ID, RUN, 'a/b')).toThrow(KeyValidationError);
    expect(() => productionKey(TENANT, ID, RUN, 'a\\b')).toThrow(KeyValidationError);
    expect(() => productionKey(TENANT, ID, RUN, `a${NUL}b`)).toThrow(KeyValidationError);
    expect(() => productionKey(TENANT, ID, RUN, '.hidden')).toThrow(KeyValidationError);
    expect(() => productionKey(TENANT, ID, RUN)).toThrow(KeyValidationError);
    expect(() => exportKey(TENANT, ID, '../escape')).toThrow(KeyValidationError);
    expect(() => exportKey(TENANT, ID)).toThrow(KeyValidationError);
  });
});

describe('sanitizeFilename', () => {
  it('neutralizes path traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFilename('/etc/shadow')).toBe('etcshadow');
    expect(sanitizeFilename('..\\..\\windows\\system32.dll')).toBe('windowssystem32.dll');
  });

  it('strips control characters including NUL', () => {
    expect(sanitizeFilename(`re${NUL}port.pdf`)).toBe('report.pdf');
    expect(sanitizeFilename(`a${String.fromCharCode(27)}b.txt`)).toBe('ab.txt');
  });

  it('strips leading dots and collapses dot runs, keeping the extension', () => {
    expect(sanitizeFilename('.hidden.txt')).toBe('hidden.txt');
    expect(sanitizeFilename('report..final.pdf')).toBe('report.final.pdf');
  });

  it('never returns an empty string', () => {
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('//')).toBe('file');
  });

  it('produces keys that pass tenant validation', () => {
    const key = derivativeKey(TENANT, ID, 'text', 1, '../..//evil\\name..txt');
    expect(() => assertKeyInTenant(TENANT, key)).not.toThrow();
  });
});

describe('assertKeyInTenant', () => {
  it('accepts a key inside the tenant prefix', () => {
    expect(() => assertKeyInTenant(TENANT, originalKey(TENANT, SHA))).not.toThrow();
  });

  it('rejects cross-tenant keys', () => {
    expect(() => assertKeyInTenant(TENANT, originalKey(OTHER_TENANT, SHA))).toThrow(
      KeyValidationError,
    );
  });

  it('rejects traversal and injection sequences', () => {
    expect(() => assertKeyInTenant(TENANT, `tenants/${TENANT}/originals/../secrets`)).toThrow(
      KeyValidationError,
    );
    expect(() => assertKeyInTenant(TENANT, `tenants/${TENANT}//originals/x`)).toThrow(
      KeyValidationError,
    );
    expect(() => assertKeyInTenant(TENANT, `tenants/${TENANT}/orig\\x`)).toThrow(
      KeyValidationError,
    );
    expect(() => assertKeyInTenant(TENANT, `tenants/${TENANT}/a${NUL}b`)).toThrow(
      KeyValidationError,
    );
    expect(() => assertKeyInTenant(TENANT, `/tenants/${TENANT}/originals/x`)).toThrow(
      KeyValidationError,
    );
  });

  it('throws a TypeError subclass', () => {
    expect(() => assertKeyInTenant(TENANT, 'nope')).toThrow(TypeError);
  });
});

describe('keyClass', () => {
  it('classifies every key class', () => {
    expect(keyClass(originalKey(TENANT, SHA))).toBe('original');
    expect(keyClass(derivativeKey(TENANT, ID, 'text', 1, 'a.txt'))).toBe('derivative');
    expect(keyClass(manifestKey(TENANT, ID))).toBe('manifest');
    expect(keyClass(productionKey(TENANT, ID, RUN, 'a'))).toBe('production');
    expect(keyClass(exportKey(TENANT, ID, 'a'))).toBe('export');
    expect(keyClass(stagingKey(TENANT, ID))).toBe('staging');
    expect(keyClass(quarantineKey(TENANT, SHA))).toBe('quarantine');
  });

  it('returns unknown for off-layout keys', () => {
    expect(keyClass('random/key')).toBe('unknown');
    expect(keyClass(`tenants/${TENANT}/other/x`)).toBe('unknown');
    expect(keyClass('tenants/not-a-uuid/originals/sha256/ab/x')).toBe('unknown');
    expect(keyClass('')).toBe('unknown');
  });
});
