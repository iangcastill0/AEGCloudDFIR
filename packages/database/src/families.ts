import { RelationshipKind } from '@prisma/client';

/**
 * What counts as a family.
 *
 * ONE definition, because there used to be several and they disagreed:
 *
 *   apps/api/src/common/families.ts   [family, attachment]
 *   apps/worker/.../export-run.ts     [attachment, inline_attachment]
 *   apps/worker/.../production-run.ts [attachment, inline_attachment]
 *   apps/worker/.../search-index.ts   [attachment, inline_attachment]
 *
 * Neither list was complete, and the gap was not academic. In a real matter
 * 866 of 1,379 attachments were `inline_attachment` — 63% of them, and 866 of
 * the 924 images. Anything expanding families through the API therefore left
 * most of the pictures behind: items added to a case with "include families",
 * a tag applied with a family behaviour, a production selection. Silently, and
 * in a product whose whole job is not losing evidence.
 *
 * An inline image is part of the document. A reader looking at the email sees
 * it; a reviewer who receives the email without it is looking at something
 * different from what the custodian sent.
 *
 * Deliberately NOT here:
 * - container_member — a PST or ZIP holds thousands of unrelated items. Its
 *   members are not a family, and treating them as one turns selecting a
 *   single message into selecting the whole archive.
 * - duplicate_of, version_of, source_path_ancestor — relationships between
 *   separate documents, not parts of one.
 */
export const FAMILY_RELATIONSHIP_KINDS: readonly RelationshipKind[] = [
  RelationshipKind.attachment,
  RelationshipKind.inline_attachment,
  RelationshipKind.family,
];

/**
 * Predicate form, for code holding a relationship kind as a plain string.
 * Prefer this over rebuilding a Set at each call site — a local Set is how the
 * definitions drifted apart in the first place.
 */
export function isFamilyRelationshipKind(kind: string): boolean {
  return (FAMILY_RELATIONSHIP_KINDS as readonly string[]).includes(kind);
}
