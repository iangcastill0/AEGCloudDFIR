import { describe, expect, it } from 'vitest';
import { PARSER_VERSIONS, collectParserVersions } from './pipeline-versions.js';

describe('PARSER_VERSIONS', () => {
  it('pins the library versions from package.json', () => {
    expect(PARSER_VERSIONS.mailparser).toBe('3.9.15');
    expect(PARSER_VERSIONS.sanitizeHtml).toBe('2.17.6');
    expect(PARSER_VERSIONS.tikaProtocol).toBe('1');
    expect(PARSER_VERSIONS.clamavProtocol).toBe('clamd-instream');
  });
});

describe('collectParserVersions', () => {
  it('produces the manifest map with runtime placeholders by default', () => {
    expect(collectParserVersions()).toEqual({
      mailparser: '3.9.15',
      'sanitize-html': '2.17.6',
      'tika-protocol': '1',
      'tesseract-cli': 'runtime',
      'clamav-protocol': 'clamd-instream',
    });
  });

  it('substitutes runtime-detected engine versions', () => {
    const versions = collectParserVersions({
      tesseractVersion: '5.3.4',
      clamavVersion: { engineVersion: '1.4.1', signatureVersion: '27484' },
    });
    expect(versions['tesseract-cli']).toBe('5.3.4');
    expect(versions['clamav-engine']).toBe('1.4.1');
    expect(versions['clamav-signatures']).toBe('27484');
  });
});
