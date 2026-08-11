/**
 * Safe email preview rendering.
 *
 * Produces HTML that is inert by construction: no scripts, no forms, no
 * frames, no remote loads of any kind. The ONLY images allowed are cid:
 * references that resolve — through the caller-provided resolver — to a
 * same-origin derivative path. Every http(s)/protocol-relative/data: image
 * (including 1x1 tracking pixels) is removed and counted, never fetched.
 *
 * This module NEVER performs network I/O itself, and the output can never
 * cause the viewer's browser to perform third-party network I/O.
 */

import sanitizeHtml from 'sanitize-html';
import { htmlToText } from './html-to-text.js';

export interface SafeEmailPreviewOptions {
  /**
   * Resolve an inline attachment content-id to a same-origin derivative
   * path (e.g. '/api/derivatives/...'). Return null when unknown; the image
   * is then removed.
   */
  allowedCidResolver?: (cid: string) => string | null;
}

export interface SafeEmailPreview {
  html: string;
  /** Remote/data images removed (tracking pixels die here). */
  blockedRemoteResources: number;
  /** script/iframe/object/embed/form/input/... elements removed. */
  removedActiveContent: number;
}

const ALLOWED_TAGS = [
  // structure & text
  'p', 'div', 'span', 'br', 'hr', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup',
  'small', 'big', 'font', 'center', 'abbr', 'cite', 'q',
  // tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'colgroup', 'col',
  // media/links (heavily constrained below)
  'img', 'a',
];

/** Tags whose presence means active content; removed and counted. */
const ACTIVE_CONTENT_TAGS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'label',
  'meta', 'link', 'base', 'style',
  'svg', 'math', 'template', 'slot', 'dialog',
  'audio', 'video', 'source', 'track', 'canvas', 'portal',
]);

const ALLOWED_STYLE_PROPERTY_RE =
  /^(?:color|background-color|font|font-[a-z-]+|text-[a-z-]+|margin|margin-[a-z]+|padding|padding-[a-z]+|border|border-[a-z-]+)$/;

const FORBIDDEN_STYLE_VALUE_RE = /url\s*\(|expression\s*\(|@import|\\/i;

const SAFE_HREF_RE = /^(?:https?:|mailto:)/i;

/**
 * Filter an inline style attribute down to the property allowlist, rejecting
 * any value that could trigger a fetch or script evaluation.
 */
export function filterStyleAttribute(style: string): string {
  if (/position\s*:\s*fixed/i.test(style)) return '';
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (value === '') continue;
    if (!ALLOWED_STYLE_PROPERTY_RE.test(property)) continue;
    if (FORBIDDEN_STYLE_VALUE_RE.test(value)) continue;
    kept.push(`${property}: ${value}`);
  }
  return kept.join('; ');
}

function normalizedScheme(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return '//';
  // Strip the whitespace (tab/newline/CR/...) browsers tolerate inside
  // schemes; anything else left in place makes the scheme regex fail closed.
  const cleaned = trimmed.replace(/\s+/g, '');
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  return match?.[1] !== undefined ? match[1].toLowerCase() + ':' : '';
}

/**
 * Sanitize an HTML email body for preview. Remote resources are never
 * fetched — every non-cid image is removed; cid images are rewritten to the
 * same-origin derivative path returned by `allowedCidResolver`.
 */
export function buildSafeEmailPreview(
  html: string,
  opts: SafeEmailPreviewOptions = {},
): SafeEmailPreview {
  let blockedRemoteResources = 0;
  let removedActiveContent = 0;
  const resolver = opts.allowedCidResolver ?? (() => null);

  const transformAll: sanitizeHtml.Transformer = (tagName, attribs) => {
    const tag = tagName.toLowerCase();

    if (ACTIVE_CONTENT_TAGS.has(tag)) {
      removedActiveContent += 1;
      // Leave the tag name as-is: it is not in allowedTags, so sanitize-html
      // discards it (and its text for nonTextTags entries like script/style).
      return { tagName: tag, attribs };
    }

    const nextAttribs: Record<string, string> = { ...attribs };

    if (typeof nextAttribs['style'] === 'string') {
      const filtered = filterStyleAttribute(nextAttribs['style']);
      if (filtered === '') {
        delete nextAttribs['style'];
      } else {
        nextAttribs['style'] = filtered;
      }
    }

    if (tag === 'a') {
      const href = nextAttribs['href'];
      if (typeof href === 'string' && SAFE_HREF_RE.test(normalizedScheme(href))) {
        nextAttribs['rel'] = 'noopener noreferrer';
        nextAttribs['target'] = '_blank';
      } else {
        // javascript:, data:, vbscript:, protocol-relative, ... — keep the
        // anchor text, drop the destination.
        delete nextAttribs['href'];
        delete nextAttribs['rel'];
        delete nextAttribs['target'];
      }
      return { tagName: 'a', attribs: nextAttribs };
    }

    if (tag === 'img') {
      const src = typeof nextAttribs['src'] === 'string' ? nextAttribs['src'].trim() : '';
      const scheme = normalizedScheme(src);
      if (scheme === 'cid:') {
        const cid = src.slice(4).trim();
        const resolved = cid === '' ? null : resolver(cid);
        if (resolved !== null) {
          nextAttribs['src'] = resolved;
          return { tagName: 'img', attribs: nextAttribs };
        }
        // Unresolvable cid: not remote, but still not renderable — remove
        // (src-less imgs are dropped by the exclusiveFilter below).
        return { tagName: 'img', attribs: {} };
      }
      if (src !== '') {
        // http(s), protocol-relative, data:, or any other scheme — this is
        // where tracking pixels and remote beacons are killed.
        blockedRemoteResources += 1;
      }
      return { tagName: 'img', attribs: {} };
    }

    return { tagName: tag, attribs: nextAttribs };
  };

  const safe = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'rel', 'target', 'title', 'style'],
      img: ['src', 'alt', 'width', 'height', 'title', 'style'],
      td: ['colspan', 'rowspan', 'style', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'style', 'align', 'valign'],
      col: ['span', 'style'],
      '*': ['style', 'align', 'dir'],
    },
    // Relative URLs (resolved cid derivatives) stay allowed; everything the
    // img/a transforms let through matches these schemes.
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    // Drop the text content of these too (script bodies, css, frame fallback).
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math', 'template'],
    transformTags: { '*': transformAll },
    // Images stripped of their src by the transform above are dropped here.
    exclusiveFilter: (frame) =>
      frame.tag === 'img' &&
      (typeof frame.attribs['src'] !== 'string' || frame.attribs['src'] === ''),
    parser: { lowerCaseTags: true, lowerCaseAttributeNames: true },
  });

  return { html: safe, blockedRemoteResources, removedActiveContent };
}

/**
 * Plain-text preview fallback chain: prefer the real text body, fall back to
 * a deterministic conversion of the HTML body, else empty string.
 */
export function buildTextPreview(bodyPlain: string, bodyHtml: string | null): string {
  const plain = bodyPlain.trim();
  if (plain !== '') return plain;
  if (bodyHtml !== null && bodyHtml.trim() !== '') return htmlToText(bodyHtml);
  return '';
}
