import { describe, expect, it } from 'vitest';
import { RelationshipKind } from '@prisma/client';
import { FAMILY_RELATIONSHIP_KINDS, isFamilyRelationshipKind } from './families.js';

describe('FAMILY_RELATIONSHIP_KINDS', () => {
  /**
   * There were four of these and they disagreed. The API used
   * [family, attachment]; the worker used [attachment, inline_attachment] in
   * three separate files. In a real matter 866 of 1,379 attachments were
   * inline_attachment — 63%, and 866 of the 924 images — so every selection
   * expanded through the API silently left most pictures behind.
   */
  it('includes inline attachments — an embedded image is part of the document', () => {
    // The one that was missing. A reviewer who gets the email without its
    // inline images is looking at something other than what was sent.
    expect(FAMILY_RELATIONSHIP_KINDS).toContain(RelationshipKind.inline_attachment);
  });

  it('includes ordinary attachments and explicit family links', () => {
    expect(FAMILY_RELATIONSHIP_KINDS).toContain(RelationshipKind.attachment);
    expect(FAMILY_RELATIONSHIP_KINDS).toContain(RelationshipKind.family);
  });

  it('excludes container members — a PST is not a family', () => {
    // A container holds thousands of unrelated items. Treating its members as
    // family would turn selecting one message into selecting the whole archive.
    expect(FAMILY_RELATIONSHIP_KINDS).not.toContain(RelationshipKind.container_member);
  });

  it('excludes relationships between separate documents', () => {
    expect(FAMILY_RELATIONSHIP_KINDS).not.toContain(RelationshipKind.duplicate_of);
    expect(FAMILY_RELATIONSHIP_KINDS).not.toContain(RelationshipKind.version_of);
    expect(FAMILY_RELATIONSHIP_KINDS).not.toContain(RelationshipKind.source_path_ancestor);
  });

  it('names every kind deliberately, so a new enum value has to be decided on', () => {
    // If someone adds a RelationshipKind, this fails and they must choose
    // whether it is family. Silence is how the lists drifted before.
    const decided = new Set<string>([
      ...FAMILY_RELATIONSHIP_KINDS,
      RelationshipKind.container_member,
      RelationshipKind.duplicate_of,
      RelationshipKind.version_of,
      RelationshipKind.source_path_ancestor,
    ]);
    expect([...Object.values(RelationshipKind)].filter((k) => !decided.has(k))).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(FAMILY_RELATIONSHIP_KINDS).size).toBe(FAMILY_RELATIONSHIP_KINDS.length);
  });
});

describe('isFamilyRelationshipKind', () => {
  it('agrees with the list', () => {
    for (const kind of Object.values(RelationshipKind)) {
      expect(isFamilyRelationshipKind(kind)).toBe(
        (FAMILY_RELATIONSHIP_KINDS as readonly string[]).includes(kind),
      );
    }
  });

  it('rejects an unknown string rather than throwing', () => {
    expect(isFamilyRelationshipKind('not_a_kind')).toBe(false);
  });
});
