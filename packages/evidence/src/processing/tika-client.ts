/**
 * Minimal Apache Tika server client for file text/metadata extraction.
 *
 * - PUT {baseUrl}/tika  (Accept: text/plain)        → extracted text
 * - PUT {baseUrl}/meta  (Accept: application/json)  → metadata map
 *
 * The response is streamed with a hard byte cap so a decompression-bomb
 * document cannot exhaust worker memory, and every request carries an abort
 * timeout. Encrypted documents surface as EncryptedContentError so the
 * caller records a processing exception — passwords are never guessed.
 *
 * The fetch implementation is injectable for tests; only the configured
 * Tika base URL is ever contacted.
 */

import {
  EncryptedContentError,
  TextExtractionTooLargeError,
  UnsupportedFormatError,
} from './errors.js';

export interface TikaClientOptions {
  /** e.g. 'http://tika:9998' (no trailing slash required). */
  baseUrl: string;
  /** Abort the request after this many milliseconds. */
  timeoutMs: number;
  /** Hard cap on response bytes; beyond it the request is aborted. */
  maxBytes: number;
  /** Injectable fetch (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

const ENCRYPTED_MARKERS = [
  'EncryptedDocumentException',
  'Unable to process: document is encrypted',
];

export class TikaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TikaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.maxBytes = options.maxBytes;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Extract plain text from a document. */
  async extractText(bytes: Buffer | Uint8Array, contentType?: string): Promise<string> {
    return this.request('/tika', bytes, 'text/plain', contentType);
  }

  /** Extract document metadata as a JSON object. */
  async extractMetadata(
    bytes: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<Record<string, unknown>> {
    const body = await this.request('/meta', bytes, 'application/json', contentType);
    return JSON.parse(body) as Record<string, unknown>;
  }

  private async request(
    path: string,
    bytes: Buffer | Uint8Array,
    accept: string,
    contentType?: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('tika request timed out')), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: accept };
      headers['Content-Type'] = contentType ?? 'application/octet-stream';
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'PUT',
        headers,
        // Send a standalone Uint8Array view so Buffer pooling never leaks
        // neighbouring bytes.
        body: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        signal: controller.signal,
      });

      const text = await this.readCapped(response, controller);

      if (!response.ok) {
        if (ENCRYPTED_MARKERS.some((marker) => text.includes(marker))) {
          throw new EncryptedContentError('document is encrypted or password protected', {
            status: response.status,
          });
        }
        if (response.status === 422) {
          throw new UnsupportedFormatError('tika cannot parse this document (unsupported or corrupt)', {
            status: response.status,
          });
        }
        throw new Error(`tika request failed with status ${response.status}`);
      }

      // Defensive: some Tika configurations return 200 with the stack trace.
      if (ENCRYPTED_MARKERS.some((marker) => text.includes(marker))) {
        throw new EncryptedContentError('document is encrypted or password protected', {
          status: response.status,
        });
      }

      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCapped(response: Response, controller: AbortController): Promise<string> {
    const body = response.body;
    if (body === null) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > this.maxBytes) {
        throw new TextExtractionTooLargeError(
          `tika response exceeded ${this.maxBytes} bytes`,
          { maxBytes: this.maxBytes },
        );
      }
      return text;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          total += value.byteLength;
          if (total > this.maxBytes) {
            controller.abort(new Error('response cap exceeded'));
            throw new TextExtractionTooLargeError(
              `tika response exceeded ${this.maxBytes} bytes`,
              { maxBytes: this.maxBytes, receivedAtLeast: total },
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
}
