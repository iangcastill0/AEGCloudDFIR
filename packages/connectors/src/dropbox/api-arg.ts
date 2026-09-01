/**
 * Encode a Dropbox API argument for an HTTP header.
 *
 * Dropbox's content endpoints (download, upload) take their JSON request body
 * in the `Dropbox-API-Arg` header rather than the body, because the body is the
 * file. HTTP headers are ASCII, so any non-ASCII character has to be escaped —
 * Dropbox documents this and rejects requests that ignore it.
 *
 * This matters more than it sounds. A custodian's files are full of accents,
 * CJK, smart quotes and emoji. Without escaping, exactly those files fail to
 * download, and the error surfaces as a provider fault rather than an encoding
 * bug, so the gap looks like the provider's.
 */

/**
 * JSON, with every non-ASCII character replaced by its \\uXXXX escape.
 *
 * Iterating UTF-16 code units rather than code points is deliberate: JSON's
 * escape is per code unit, so an emoji has to become a surrogate PAIR of
 * escapes. Escaping by code point produces a value Dropbox rejects.
 */
export function dropboxApiArg(arg: unknown): string {
  const json = JSON.stringify(arg) ?? 'null';
  let out = '';
  for (const char of json) {
    for (let i = 0; i < char.length; i += 1) {
      const unit = char.charCodeAt(i);
      out += unit < 0x80 ? String.fromCharCode(unit) : `\\u${unit.toString(16).padStart(4, '0')}`;
    }
  }
  return out;
}
