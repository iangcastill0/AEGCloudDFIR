import { z } from 'zod';
import { idempotencyKey, uuid } from './common.js';

export const productionOutputMode = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('natives_only') }),
  z.object({
    mode: z.literal('pdf_only'),
    pdfGrouping: z.enum(['per_page', 'per_document', 'per_family', 'bulk']),
  }),
  z.object({
    mode: z.literal('load_file'),
    imageFormat: z.enum(['tiff_g4', 'jpeg', 'pdf', 'none']),
    includeNatives: z.boolean().default(false),
    includeText: z.boolean().default(true),
    loadFileFormats: z.array(z.enum(['dat', 'opt', 'csv'])).min(1),
  }),
]);

export const stampPosition = z.enum([
  'top_left',
  'top_center',
  'top_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
]);

export const stampConfig = z.object({
  position: stampPosition,
  kind: z.enum(['bates', 'tag', 'confidentiality', 'custom']),
  text: z.string().max(120).default(''),
  priority: z.number().int().min(1).max(10).default(5),
  addedMarginPoints: z.number().min(0).max(72).default(0),
});

export const batesConfig = z.object({
  prefix: z.string().regex(/^[A-Za-z0-9_-]{0,20}$/),
  startNumber: z.number().int().min(1),
  digits: z.number().int().min(4).max(12).default(8),
  suffix: z.string().regex(/^[A-Za-z0-9_-]{0,10}$/).default(''),
  numbering: z.enum(['per_page', 'per_document']).default('per_page'),
});

export const redactionConfig = z.object({
  stage: z.enum(['preview', 'final']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#000000'),
  label: z.string().max(60).default('REDACTED'),
  enforceImageOnly: z.boolean().default(true),
});

export const productionSort = z.enum([
  'folder_filename',
  'filename',
  'primary_date_asc',
  'primary_date_desc',
  'custodian',
  'evidence_id',
]);

export const filenameScheme = z.enum(['bates', 'original', 'bates_original']);

export const productionParameters = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  selection: z.object({
    tagIds: z.array(uuid).default([]),
    savedSearchIds: z.array(uuid).default([]),
    inverted: z.boolean().default(false),
    excludePreviouslyProduced: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('any_earlier') }),
      z.object({ kind: z.literal('selected'), productionIds: z.array(uuid).min(1) }),
    ]),
    includeFamilies: z.boolean().default(true),
  }),
  output: productionOutputMode,
  nativePolicy: z.object({
    extensions: z.array(z.string().regex(/^[a-z0-9]{1,10}$/)).default([]),
    tagIds: z.array(uuid).default([]),
    /** Safety: redacted/privileged items are excluded from native output
     * regardless of this list unless a security-critical override with a
     * second confirmation is recorded. */
    subjectToSafetyOverrides: z.literal(true).default(true),
  }),
  sort: productionSort,
  stamps: z.array(stampConfig).max(6),
  redactions: redactionConfig,
  bates: batesConfig,
  filenames: filenameScheme,
});
export type ProductionParameters = z.infer<typeof productionParameters>;

export const createProductionRequest = z.object({
  idempotencyKey,
  caseId: uuid.optional(),
  parameters: productionParameters,
});

export const validationFlagCode = z.enum([
  'redacted_native_leak',
  'redacted_ancestor_native_leak',
  'privileged_item',
  'privileged_descendant_container',
  'archive_container',
  'duplicate_item',
  'malware_item',
  'missing_native',
  'unsupported_conversion',
  'unprocessed_item',
  'encrypted_file',
  'missing_text',
  'duplicate_bates_range',
  'zero_byte_item',
  'corrupt_item',
  'family_split',
  'preview_redactions_in_release',
  'selection_changed_since_draft',
]);

export const validationFlag = z.object({
  code: validationFlagCode,
  severity: z.enum(['info', 'warning', 'blocking', 'security_critical']),
  message: z.string(),
  evidenceItemIds: z.array(uuid),
  overridable: z.boolean(),
  /** security_critical flags additionally require elevated permission + second confirmation. */
  requiresElevatedOverride: z.boolean(),
});

export const validateProductionResponse = z.object({
  draftCalculatedAt: z.string(),
  itemCount: z.number().int(),
  estimatedPageCount: z.number().int().nullable(),
  flags: z.array(validationFlag),
  canSubmit: z.boolean(),
});

export const submitProductionRequest = z.object({
  acknowledgedWarnings: z.array(
    z.object({
      code: validationFlagCode,
      note: z.string().max(1000).default(''),
      /** Second confirmation token for security-critical overrides. */
      secondConfirmation: z.boolean().default(false),
    }),
  ),
  expectedDraftCalculatedAt: z.string(),
});

export const productionRunStatusResponse = z.object({
  id: uuid,
  runNumber: z.number().int(),
  status: z.enum([
    'queued',
    'rendering',
    'stamping',
    'verifying',
    'ready',
    'released',
    'failed',
    'cancelled',
  ]),
  progress: z.record(z.string(), z.number()),
  batesStart: z.string(),
  batesEnd: z.string(),
  exceptionCounts: z.record(z.string(), z.number()),
  manifestSha256: z.string(),
});
