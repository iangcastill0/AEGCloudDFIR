/**
 * Parser/engine version identifiers recorded on collection manifests so any
 * derivative (extracted text, preview, OCR output) can be attributed to the
 * exact software that produced it.
 *
 * Library versions are the exact pins from packages/evidence/package.json;
 * runtime-detected engines (tesseract, clamav) are placeholders until the
 * worker resolves them via TesseractOcr.version() / ClamAvScanner.version().
 */

export const PARSER_VERSIONS = {
  /** Pinned in package.json. */
  mailparser: '3.9.15',
  /** Pinned in package.json. */
  sanitizeHtml: '2.17.6',
  /** Tika server REST protocol we speak (PUT /tika, PUT /meta). */
  tikaProtocol: '1',
  /** Resolved at runtime via `tesseract --version`. */
  tesseractCli: 'runtime',
  /** clamd wire protocol used for scanning. */
  clamavProtocol: 'clamd-instream',
} as const;

export interface CollectParserVersionsInput {
  /** From TesseractOcr.version(), e.g. '5.3.4'. */
  tesseractVersion?: string;
  /** From ClamAvScanner.version(), e.g. { engine: '1.4.1', sigs: '27484' }. */
  clamavVersion?: { engineVersion: string; signatureVersion: string };
}

/**
 * Produce the manifest `parserVersions` map, substituting runtime-detected
 * engine versions when available.
 */
export function collectParserVersions(
  input: CollectParserVersionsInput = {},
): Record<string, string> {
  const versions: Record<string, string> = {
    mailparser: PARSER_VERSIONS.mailparser,
    'sanitize-html': PARSER_VERSIONS.sanitizeHtml,
    'tika-protocol': PARSER_VERSIONS.tikaProtocol,
    'tesseract-cli': input.tesseractVersion ?? PARSER_VERSIONS.tesseractCli,
    'clamav-protocol': PARSER_VERSIONS.clamavProtocol,
  };
  if (input.clamavVersion !== undefined) {
    versions['clamav-engine'] = input.clamavVersion.engineVersion;
    versions['clamav-signatures'] = input.clamavVersion.signatureVersion;
  }
  return versions;
}
