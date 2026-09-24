import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards on the vendored PST writer.
 *
 * Both things checked here are SILENT and FATAL. Neither shows up as a failed
 * build, a thrown error, or a wrong number in a report — the export completes,
 * the file is written, and then nothing can read it. A comment would not have
 * survived the next person re-copying upstream, so they are tests.
 */

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const VENDOR = join(REPO_ROOT, 'services/pst-builder/vendor/PST-Builder/src');
const CLI = join(REPO_ROOT, 'services/pst-builder/cli/Program.cs');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('the named-property trap', () => {
  /**
   * With NO named properties anywhere in the file, libpff refuses to open the
   * PST at all: "libpff_name_to_id_map_read: missing name to id map entries
   * data". The writer only emits map entries for named properties that are
   * actually used, and ordinary mail uses none — so a PST of plain email is
   * rejected outright by every libpff-based tool, including our own validation.
   *
   * Measured: the spike's 12-message fixture PST would not open until one
   * named property was attached per message. Nothing about that is visible from
   * the writer's side. It reports success and exits 0.
   */
  it('attaches a marker named property to every message', () => {
    const cli = read(CLI);
    expect(cli).toContain('NamedProperty.Text(PropertySets.Common, MarkerPropertyId');
    expect(cli).toContain('item.NamedProperties.Add(');
    // The property id itself, so a rename cannot quietly drop the seeding while
    // leaving a call that adds nothing.
    expect(cli).toMatch(/MarkerPropertyId\s*=\s*0x8580/);
  });

  it('declares the marker as derived, not collected', () => {
    // It is a property this product invented. An export that did not say so
    // would be presenting a fabricated MAPI property as if it had been
    // acquired.
    const cli = read(CLI);
    expect(cli).toContain('aeg-clouddfir-export');
  });
});

describe('the vendored no-attachment patch', () => {
  /**
   * Upstream writes a message's attachment table only when the message has an
   * attachment. libpff then fails `libpff_message_determine_attachments` on
   * EVERY message that has none — and most real mail has none. 9 of 12 fixture
   * messages produced an error before the patch; 0 after it.
   *
   * Re-copying upstream would silently undo this, and the symptom would be an
   * error per message in validation rather than anything that looks like a lost
   * patch. See services/pst-builder/UPSTREAM.md.
   */
  it('still emits the attachment-table subnode unconditionally', () => {
    const writer = read(join(VENDOR, 'PstBuilder/Messaging/StoreWriter.cs'));
    expect(writer).toContain('AddAttachmentSubnodes(m, subEntries, attachSizes);');
    // The upstream form, which is what the patch removes.
    expect(writer).not.toContain(
      'if (m.Attachments.Count > 0) AddAttachmentSubnodes(m, subEntries, attachSizes);',
    );
  });

  it('keeps the patch file that documents the delta', () => {
    const patch = read(
      join(
        REPO_ROOT,
        'services/pst-builder/patches/0001-always-emit-attachment-table-subnode.patch',
      ),
    );
    expect(patch).toContain('AddAttachmentSubnodes');
    expect(patch).toContain('StoreWriter.cs');
  });
});

describe('split parts', () => {
  /**
   * Byte-range volumes are not acceptable here. A volume nobody rejoined is
   * indistinguishable from a corrupt evidence file to a recipient.
   * `CreateSplit` writes a complete PST per part; `Create` does not split at a
   * caller-chosen size.
   */
  it('uses CreateSplit so every part is a whole PST', () => {
    const cli = read(CLI);
    expect(cli).toContain('PstExportSession.CreateSplit(');
  });
});
