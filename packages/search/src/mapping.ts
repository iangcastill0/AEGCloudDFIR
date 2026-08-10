/**
 * Versioned OpenSearch index mapping for evidence documents.
 *
 * Indexes are named `${prefix}-evidence-v${version}` and reads/writes always
 * go through the alias `${prefix}-evidence`, so a reindex can swap the alias
 * atomically to a new version.
 */

export const MAPPING_VERSION = 1;

export function buildIndexName(prefix: string, version: number): string {
  return `${prefix}-evidence-v${version}`;
}

export function buildAliasName(prefix: string): string {
  return `${prefix}-evidence`;
}

type MappingObject = Record<string, unknown>;

const keyword: MappingObject = { type: 'keyword' };
const keywordLower: MappingObject = { type: 'keyword', normalizer: 'lowercase_normalizer' };
const boolField: MappingObject = { type: 'boolean' };
const dateField: MappingObject = { type: 'date', ignore_malformed: false };
const englishText: MappingObject = { type: 'text', analyzer: 'english' };

/** text + keyword multi-field (folded analyzer for text, lowercase keyword). */
const textWithKeyword: MappingObject = {
  type: 'text',
  analyzer: 'folded',
  fields: {
    keyword: { type: 'keyword', normalizer: 'lowercase_normalizer', ignore_above: 512 },
  },
};

const subjectField: MappingObject = {
  type: 'text',
  analyzer: 'english',
  fields: {
    keyword: { type: 'keyword', normalizer: 'lowercase_normalizer', ignore_above: 512 },
  },
};

/** Email address object: address keyword (lowercased) + text sub-field, keyword domain. */
const addressObject: MappingObject = {
  properties: {
    name: { type: 'text', analyzer: 'folded' },
    address: {
      type: 'keyword',
      normalizer: 'lowercase_normalizer',
      fields: { text: { type: 'text', analyzer: 'folded' } },
    },
    domain: keywordLower,
  },
};

export const EVIDENCE_MAPPING = {
  settings: {
    index: {
      max_result_window: 10000,
    },
    analysis: {
      normalizer: {
        lowercase_normalizer: {
          type: 'custom',
          char_filter: [],
          filter: ['lowercase', 'asciifolding'],
        },
      },
      analyzer: {
        folded: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding'],
        },
      },
    },
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      evidenceItemId: keyword,
      tenantId: keyword,
      kind: keyword,
      name: textWithKeyword,
      extension: keywordLower,
      mimeType: keywordLower,
      size: { type: 'long' },
      sha256: keywordLower,
      custodianId: keyword,
      custodianEmail: keywordLower,
      provider: keyword,
      connectorAccountId: keyword,
      collectionId: keyword,
      sourcePath: keyword,
      sourceLabels: keywordLower,
      folder: keyword,
      dates: {
        properties: {
          sent: dateField,
          received: dateField,
          created: dateField,
          modified: dateField,
          acquired: dateField,
          primary: dateField,
        },
      },
      email: {
        properties: {
          subject: subjectField,
          messageId: keyword,
          inReplyTo: keyword,
          references: keyword,
          threadId: keyword,
          from: addressObject,
          sender: addressObject,
          to: addressObject,
          cc: addressObject,
          bcc: addressObject,
          replyTo: addressObject,
          bccPresent: boolField,
        },
      },
      headers: {
        type: 'nested',
        properties: {
          name: keywordLower,
          value: {
            type: 'text',
            fields: {
              keyword: { type: 'keyword', normalizer: 'lowercase_normalizer', ignore_above: 1024 },
            },
          },
        },
      },
      addresses: {
        properties: {
          all: keywordLower,
          domains: keywordLower,
        },
      },
      text: {
        properties: {
          body: englishText,
          bodyHtml: englishText,
          attachment: englishText,
          file: englishText,
          ocr: englishText,
        },
      },
      ocrPages: {
        type: 'nested',
        properties: {
          page: { type: 'integer' },
          text: englishText,
          confidence: { type: 'float' },
        },
      },
      tags: {
        type: 'nested',
        properties: {
          id: keyword,
          name: keywordLower,
          privileged: boolField,
          confidential: boolField,
        },
      },
      tagNames: keywordLower,
      caseIds: keyword,
      privileged: boolField,
      confidential: boolField,
      processingStatus: keyword,
      malwareStatus: keyword,
      familyId: keyword,
      parentId: keyword,
      isFamilyChild: boolField,
      bates: {
        type: 'nested',
        properties: {
          productionId: keyword,
          productionName: keyword,
          begBates: keywordLower,
          endBates: keywordLower,
        },
      },
      hasBeenProduced: boolField,
      indexedAt: dateField,
      docVersion: { type: 'integer' },
    },
  },
} as const;
