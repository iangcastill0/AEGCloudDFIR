/**
 * Naming for the case a collection files itself under.
 *
 * Collecting was only ever half the job. The evidence has to end up somewhere
 * a reviewer can open, and that used to mean creating a case by hand and then
 * adding the collection to it — a step easy to forget, and silent when
 * forgotten: the collection reads as finished while being unreviewable.
 *
 * Kept pure so the naming rules can be tested without a database.
 */

/** Matches the `name` limit on Case in the schema. */
const MAX_CASE_NAME = 200;

/**
 * The name for a case created alongside a collection.
 *
 * It carries the collection's own name so the two are recognisable as the same
 * piece of work. The date disambiguates the common real case — collecting the
 * same mailbox again next month — where two cases would otherwise be
 * identically named and indistinguishable in a list.
 */
export function autoCaseName(collectionName: string, createdAt: Date): string {
  const date = createdAt.toISOString().slice(0, 10);
  const trimmed = collectionName.trim();
  const base = trimmed === '' ? 'Collection' : trimmed;
  const suffix = ` (${date})`;
  // Truncate the NAME, never the date: a name cut short is still recognisable,
  // a half-written date is misleading.
  const room = MAX_CASE_NAME - suffix.length;
  const head = base.length > room ? base.slice(0, room - 1).trimEnd() + '…' : base;
  return `${head}${suffix}`;
}

/** Description recording why the case exists, so nobody wonders later. */
export function autoCaseDescription(collectionName: string): string {
  return (
    `Created automatically for the collection "${collectionName.trim()}". ` +
    `Everything that collection preserves is filed here.`
  );
}
