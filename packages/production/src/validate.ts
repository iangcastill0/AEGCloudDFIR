import type {
  ProductionOutputMode,
  RedactionStage,
  ValidationFlag,
  ValidationFlagCode,
  ValidationSeverity,
} from './types.js';

export type MalwareStatus = 'clean' | 'unscanned' | 'suspicious' | 'infected';

/** Per-item facts the validation engine evaluates. The worker maps DB rows into this. */
export interface ValidationItem {
  evidenceId: string;
  familyId: string | null;
  parentId?: string | null;
  hasFinalRedactions: boolean;
  hasPreviewRedactions: boolean;
  isPrivileged: boolean;
  hasPrivilegedDescendant: boolean;
  isArchiveContainer: boolean;
  isDuplicate: boolean;
  malwareStatus: MalwareStatus;
  hasNative: boolean;
  conversionSupported: boolean;
  processed: boolean;
  isEncrypted: boolean;
  hasText: boolean;
  sizeBytes: number;
  /** True when the current native policy would emit this item's native file. */
  wouldProduceNative: boolean;
  isCorrupt?: boolean;
  isFamilyChild?: boolean;
}

export interface ValidationParams {
  includeFamilies: boolean;
  redactionStage: RedactionStage;
  output: ProductionOutputMode;
}

interface FlagDefinition {
  severity: ValidationSeverity;
  overridable: boolean;
  requiresElevatedOverride: boolean;
  message: string;
}

/**
 * Severity/override policy per flag code. security_critical flags are never
 * plainly overridable — they require elevated permission + second confirmation.
 */
export const FLAG_DEFINITIONS: Record<ValidationFlagCode, FlagDefinition> = {
  redacted_native_leak: {
    severity: 'security_critical',
    overridable: false,
    requiresElevatedOverride: true,
    message:
      'Native output would leak unredacted content of an item with final redactions (or a redacted descendant).',
  },
  redacted_ancestor_native_leak: {
    severity: 'security_critical',
    overridable: false,
    requiresElevatedOverride: true,
    message:
      'Native output of an item extracted from a container with final redactions would leak redacted content.',
  },
  privileged_item: {
    severity: 'warning',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Selection includes items marked privileged.',
  },
  privileged_descendant_container: {
    severity: 'warning',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Selection includes containers with privileged descendants.',
  },
  archive_container: {
    severity: 'warning',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Selection includes archive containers (zip/pst/etc.).',
  },
  duplicate_item: {
    severity: 'info',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Selection includes items marked as duplicates.',
  },
  malware_item: {
    severity: 'blocking',
    overridable: false,
    requiresElevatedOverride: false,
    message: 'Selection includes items flagged as malware.',
  },
  missing_native: {
    severity: 'warning',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Native output was requested for items that have no stored native file.',
  },
  unsupported_conversion: {
    severity: 'warning',
    overridable: true,
    requiresElevatedOverride: false,
    message:
      'Items cannot be converted to the requested image format; placeholders will be produced.',
  },
  unprocessed_item: {
    severity: 'blocking',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Selection includes items whose processing has not completed.',
  },
  encrypted_file: {
    severity: 'warning',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Selection includes encrypted files that could not be opened.',
  },
  missing_text: {
    severity: 'warning',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Text output was requested for items that have no extracted text.',
  },
  duplicate_bates_range: {
    severity: 'blocking',
    overridable: false,
    requiresElevatedOverride: false,
    message: 'The requested bates range collides with an existing production.',
  },
  zero_byte_item: {
    severity: 'warning',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Selection includes zero-byte items.',
  },
  corrupt_item: {
    severity: 'blocking',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Selection includes items detected as corrupt.',
  },
  family_split: {
    severity: 'blocking',
    overridable: true,
    requiresElevatedOverride: false,
    message: 'Family grouping is enabled but the selection splits at least one family.',
  },
  preview_redactions_in_release: {
    severity: 'blocking',
    overridable: false,
    requiresElevatedOverride: false,
    message:
      'A final production was requested but items still carry unresolved preview-stage redactions.',
  },
  selection_changed_since_draft: {
    severity: 'blocking',
    overridable: false,
    requiresElevatedOverride: false,
    message: 'The underlying selection changed after the draft was validated.',
  },
};

function makeFlag(code: ValidationFlagCode, evidenceItemIds: string[]): ValidationFlag {
  const def = FLAG_DEFINITIONS[code];
  return {
    code,
    severity: def.severity,
    message: def.message,
    evidenceItemIds,
    overridable: def.overridable,
    requiresElevatedOverride: def.requiresElevatedOverride,
  };
}

/**
 * Evaluate a production selection against release-safety rules.
 * Returns one flag per triggered code, each carrying every offending item id.
 *
 * `duplicate_bates_range` and `selection_changed_since_draft` are evaluated by
 * the persistence layer and never produced here.
 */
export function validateProductionSet(
  items: readonly ValidationItem[],
  params: ValidationParams,
): ValidationFlag[] {
  const byId = new Map<string, ValidationItem>();
  const childrenOf = new Map<string, ValidationItem[]>();
  for (const item of items) {
    byId.set(item.evidenceId, item);
  }
  for (const item of items) {
    const parentId = item.parentId ?? null;
    if (parentId !== null && byId.has(parentId)) {
      const siblings = childrenOf.get(parentId);
      if (siblings) siblings.push(item);
      else childrenOf.set(parentId, [item]);
    }
  }

  const descendantHasFinalRedactions = (item: ValidationItem): boolean => {
    const stack = [...(childrenOf.get(item.evidenceId) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current.hasFinalRedactions) return true;
      stack.push(...(childrenOf.get(current.evidenceId) ?? []));
    }
    return false;
  };

  const ancestorHasFinalRedactions = (item: ValidationItem): boolean => {
    let parentId = item.parentId ?? null;
    const seen = new Set<string>([item.evidenceId]);
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (parent === undefined) return false;
      if (parent.hasFinalRedactions) return true;
      parentId = parent.parentId ?? null;
    }
    return false;
  };

  const descendantIsPrivileged = (item: ValidationItem): boolean => {
    const stack = [...(childrenOf.get(item.evidenceId) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current.isPrivileged) return true;
      stack.push(...(childrenOf.get(current.evidenceId) ?? []));
    }
    return false;
  };

  const output = params.output;
  const rendersImages =
    output.mode === 'pdf_only' || (output.mode === 'load_file' && output.imageFormat !== 'none');
  const wantsText = output.mode === 'load_file' && output.includeText;

  const offenders = new Map<ValidationFlagCode, string[]>();
  const add = (code: ValidationFlagCode, id: string): void => {
    const ids = offenders.get(code);
    if (ids) ids.push(id);
    else offenders.set(code, [id]);
  };

  for (const item of items) {
    const id = item.evidenceId;

    if (item.wouldProduceNative && (item.hasFinalRedactions || descendantHasFinalRedactions(item))) {
      add('redacted_native_leak', id);
    }
    if (item.wouldProduceNative && ancestorHasFinalRedactions(item)) {
      add('redacted_ancestor_native_leak', id);
    }
    if (item.isPrivileged) add('privileged_item', id);
    if (!item.isPrivileged && (item.hasPrivilegedDescendant || descendantIsPrivileged(item))) {
      add('privileged_descendant_container', id);
    }
    if (item.isArchiveContainer) add('archive_container', id);
    if (item.isDuplicate) add('duplicate_item', id);
    if (item.malwareStatus === 'infected' || item.malwareStatus === 'suspicious') {
      add('malware_item', id);
    }
    const needsNative = output.mode === 'natives_only' || item.wouldProduceNative;
    if (needsNative && !item.hasNative) add('missing_native', id);
    if (rendersImages && !item.conversionSupported) add('unsupported_conversion', id);
    if (!item.processed) add('unprocessed_item', id);
    if (item.isEncrypted) add('encrypted_file', id);
    if (wantsText && !item.hasText) add('missing_text', id);
    if (item.sizeBytes === 0) add('zero_byte_item', id);
    if (item.isCorrupt === true) add('corrupt_item', id);
    if (params.redactionStage === 'final' && item.hasPreviewRedactions) {
      add('preview_redactions_in_release', id);
    }
  }

  if (params.includeFamilies) {
    const families = new Map<string, ValidationItem[]>();
    for (const item of items) {
      if (item.familyId !== null) {
        const members = families.get(item.familyId);
        if (members) members.push(item);
        else families.set(item.familyId, [item]);
      }
    }
    for (const members of families.values()) {
      const isChild = (m: ValidationItem): boolean =>
        m.isFamilyChild ?? (m.parentId !== null && m.parentId !== undefined);
      const children = members.filter(isChild);
      const parents = members.filter((m) => !isChild(m));
      if (parents.length === 0 && children.length > 0) {
        // Children selected without their parent.
        for (const child of children) add('family_split', child.evidenceId);
      } else if (parents.length > 0 && children.length === 0) {
        // Parent of a family selected without any of its children.
        for (const parent of parents) add('family_split', parent.evidenceId);
      }
    }
  }

  const flags: ValidationFlag[] = [];
  for (const [code, ids] of offenders) {
    flags.push(makeFlag(code, [...new Set(ids)].sort()));
  }
  flags.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return flags;
}
