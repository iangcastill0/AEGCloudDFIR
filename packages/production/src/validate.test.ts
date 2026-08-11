import { describe, expect, it } from 'vitest';
import { validateProductionSet, type ValidationItem, type ValidationParams } from './validate.js';
import type { ValidationFlag, ValidationFlagCode } from './types.js';

function item(overrides: Partial<ValidationItem> & { evidenceId: string }): ValidationItem {
  return {
    familyId: null,
    parentId: null,
    hasFinalRedactions: false,
    hasPreviewRedactions: false,
    isPrivileged: false,
    hasPrivilegedDescendant: false,
    isArchiveContainer: false,
    isDuplicate: false,
    malwareStatus: 'clean',
    hasNative: true,
    conversionSupported: true,
    processed: true,
    isEncrypted: false,
    hasText: true,
    sizeBytes: 1024,
    wouldProduceNative: false,
    ...overrides,
  };
}

const defaultParams: ValidationParams = {
  includeFamilies: true,
  redactionStage: 'final',
  output: {
    mode: 'load_file',
    imageFormat: 'tiff_g4',
    includeNatives: true,
    includeText: true,
    loadFileFormats: ['dat', 'opt'],
  },
};

function flag(flags: ValidationFlag[], code: ValidationFlagCode): ValidationFlag | undefined {
  return flags.find((f) => f.code === code);
}

describe('validateProductionSet', () => {
  it('returns no flags for a clean selection', () => {
    expect(validateProductionSet([item({ evidenceId: 'a' })], defaultParams)).toEqual([]);
  });

  it('redacted_native_leak: security_critical, not overridable, elevated override required', () => {
    const flags = validateProductionSet(
      [item({ evidenceId: 'a', hasFinalRedactions: true, wouldProduceNative: true })],
      defaultParams,
    );
    const f = flag(flags, 'redacted_native_leak');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('security_critical');
    expect(f?.overridable).toBe(false);
    expect(f?.requiresElevatedOverride).toBe(true);
    expect(f?.evidenceItemIds).toEqual(['a']);
  });

  it('redacted_native_leak fires for a container whose descendant is redacted', () => {
    const flags = validateProductionSet(
      [
        item({ evidenceId: 'container', wouldProduceNative: true, isArchiveContainer: true }),
        item({ evidenceId: 'mid', parentId: 'container' }),
        item({ evidenceId: 'leaf', parentId: 'mid', hasFinalRedactions: true }),
      ],
      defaultParams,
    );
    expect(flag(flags, 'redacted_native_leak')?.evidenceItemIds).toEqual(['container']);
  });

  it('redacted_ancestor_native_leak: item under a redacted ancestor would produce native', () => {
    const flags = validateProductionSet(
      [
        item({ evidenceId: 'parent', hasFinalRedactions: true }),
        item({ evidenceId: 'child', parentId: 'parent', wouldProduceNative: true }),
      ],
      defaultParams,
    );
    const f = flag(flags, 'redacted_ancestor_native_leak');
    expect(f?.severity).toBe('security_critical');
    expect(f?.overridable).toBe(false);
    expect(f?.requiresElevatedOverride).toBe(true);
    expect(f?.evidenceItemIds).toEqual(['child']);
  });

  it('privileged_item: warning, overridable', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', isPrivileged: true })], defaultParams),
      'privileged_item',
    );
    expect(f?.severity).toBe('warning');
    expect(f?.overridable).toBe(true);
    expect(f?.requiresElevatedOverride).toBe(false);
  });

  it('privileged_descendant_container: warning for containers, via flag or item graph', () => {
    const flags = validateProductionSet(
      [
        item({ evidenceId: 'zip1', hasPrivilegedDescendant: true }),
        item({ evidenceId: 'zip2' }),
        item({ evidenceId: 'inner', parentId: 'zip2', isPrivileged: true }),
      ],
      defaultParams,
    );
    const f = flag(flags, 'privileged_descendant_container');
    expect(f?.severity).toBe('warning');
    expect(f?.overridable).toBe(true);
    expect(f?.evidenceItemIds).toEqual(['zip1', 'zip2']);
  });

  it('archive_container: warning, overridable', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', isArchiveContainer: true })], defaultParams),
      'archive_container',
    );
    expect(f?.severity).toBe('warning');
    expect(f?.overridable).toBe(true);
  });

  it('duplicate_item: info, overridable', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', isDuplicate: true })], defaultParams),
      'duplicate_item',
    );
    expect(f?.severity).toBe('info');
    expect(f?.overridable).toBe(true);
  });

  it('malware_item: blocking, not overridable, fires for infected and suspicious', () => {
    const flags = validateProductionSet(
      [
        item({ evidenceId: 'a', malwareStatus: 'infected' }),
        item({ evidenceId: 'b', malwareStatus: 'suspicious' }),
        item({ evidenceId: 'c', malwareStatus: 'unscanned' }),
      ],
      defaultParams,
    );
    const f = flag(flags, 'malware_item');
    expect(f?.severity).toBe('blocking');
    expect(f?.overridable).toBe(false);
    expect(f?.evidenceItemIds).toEqual(['a', 'b']);
  });

  it('missing_native: warning when native output is requested but no native exists', () => {
    const f = flag(
      validateProductionSet(
        [item({ evidenceId: 'a', wouldProduceNative: true, hasNative: false })],
        defaultParams,
      ),
      'missing_native',
    );
    expect(f?.severity).toBe('warning');
    expect(f?.overridable).toBe(true);
    // natives_only mode flags every native-less item
    const f2 = flag(
      validateProductionSet([item({ evidenceId: 'b', hasNative: false })], {
        ...defaultParams,
        output: { mode: 'natives_only' },
      }),
      'missing_native',
    );
    expect(f2?.evidenceItemIds).toEqual(['b']);
  });

  it('unsupported_conversion: warning when images are rendered, silent for natives_only', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', conversionSupported: false })], defaultParams),
      'unsupported_conversion',
    );
    expect(f?.severity).toBe('warning');
    expect(f?.overridable).toBe(true);
    const nativesOnly = validateProductionSet(
      [item({ evidenceId: 'a', conversionSupported: false })],
      { ...defaultParams, output: { mode: 'natives_only' } },
    );
    expect(flag(nativesOnly, 'unsupported_conversion')).toBeUndefined();
  });

  it('unprocessed_item: blocking, overridable', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', processed: false })], defaultParams),
      'unprocessed_item',
    );
    expect(f?.severity).toBe('blocking');
    expect(f?.overridable).toBe(true);
  });

  it('encrypted_file: warning, overridable', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', isEncrypted: true })], defaultParams),
      'encrypted_file',
    );
    expect(f?.severity).toBe('warning');
    expect(f?.overridable).toBe(true);
  });

  it('missing_text: warning only when text output was requested', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', hasText: false })], defaultParams),
      'missing_text',
    );
    expect(f?.severity).toBe('warning');
    expect(f?.overridable).toBe(true);
    const withoutText = validateProductionSet([item({ evidenceId: 'a', hasText: false })], {
      ...defaultParams,
      output: {
        ...defaultParams.output,
        mode: 'load_file',
        includeText: false,
        imageFormat: 'tiff_g4',
        includeNatives: false,
        loadFileFormats: ['dat'],
      },
    });
    expect(flag(withoutText, 'missing_text')).toBeUndefined();
  });

  it('zero_byte_item: warning, overridable', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', sizeBytes: 0 })], defaultParams),
      'zero_byte_item',
    );
    expect(f?.severity).toBe('warning');
    expect(f?.overridable).toBe(true);
  });

  it('corrupt_item: blocking, overridable', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', isCorrupt: true })], defaultParams),
      'corrupt_item',
    );
    expect(f?.severity).toBe('blocking');
    expect(f?.overridable).toBe(true);
  });

  it('family_split: child selected without its parent', () => {
    const flags = validateProductionSet(
      [item({ evidenceId: 'child', familyId: 'F1', parentId: 'gone', isFamilyChild: true })],
      defaultParams,
    );
    const f = flag(flags, 'family_split');
    expect(f?.severity).toBe('blocking');
    expect(f?.overridable).toBe(true);
    expect(f?.evidenceItemIds).toEqual(['child']);
  });

  it('family_split: parent selected without any of its children', () => {
    const flags = validateProductionSet(
      [item({ evidenceId: 'parent', familyId: 'F1', isFamilyChild: false })],
      defaultParams,
    );
    expect(flag(flags, 'family_split')?.evidenceItemIds).toEqual(['parent']);
  });

  it('family_split: intact families and disabled includeFamilies produce no flag', () => {
    const intact = validateProductionSet(
      [
        item({ evidenceId: 'p', familyId: 'F1', isFamilyChild: false }),
        item({ evidenceId: 'c', familyId: 'F1', parentId: 'p', isFamilyChild: true }),
      ],
      defaultParams,
    );
    expect(flag(intact, 'family_split')).toBeUndefined();
    const disabled = validateProductionSet(
      [item({ evidenceId: 'child', familyId: 'F1', parentId: 'gone', isFamilyChild: true })],
      { ...defaultParams, includeFamilies: false },
    );
    expect(flag(disabled, 'family_split')).toBeUndefined();
  });

  it('preview_redactions_in_release: blocking for final stage, silent for preview stage', () => {
    const f = flag(
      validateProductionSet([item({ evidenceId: 'a', hasPreviewRedactions: true })], defaultParams),
      'preview_redactions_in_release',
    );
    expect(f?.severity).toBe('blocking');
    expect(f?.overridable).toBe(false);
    const preview = validateProductionSet([item({ evidenceId: 'a', hasPreviewRedactions: true })], {
      ...defaultParams,
      redactionStage: 'preview',
    });
    expect(flag(preview, 'preview_redactions_in_release')).toBeUndefined();
  });

  it('aggregates offenders into a single flag per code with sorted unique ids', () => {
    const flags = validateProductionSet(
      [
        item({ evidenceId: 'z', isPrivileged: true }),
        item({ evidenceId: 'a', isPrivileged: true }),
      ],
      defaultParams,
    );
    expect(flag(flags, 'privileged_item')?.evidenceItemIds).toEqual(['a', 'z']);
    expect(flags.filter((f) => f.code === 'privileged_item')).toHaveLength(1);
  });
});
