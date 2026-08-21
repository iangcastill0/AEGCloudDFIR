/**
 * Describe the outcome in words, from the counts the API returns.
 *
 * Shared by the card's own message and the page's live region so the two can
 * never disagree.
 */
export function addItemsMessage(result: { requested: number; added: number }): string {
  if (result.added === 0) {
    return result.requested === 0
      ? 'Nothing matched that selection, so no items were added.'
      : `No new items added — all ${String(result.requested)} were already in the case.`;
  }
  const already = result.requested - result.added;
  return already > 0
    ? `Added ${String(result.added)} item(s). ${String(already)} were already in the case.`
    : `Added ${String(result.added)} item(s) to the case.`;
}
