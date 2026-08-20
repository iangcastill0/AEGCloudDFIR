/**
 * Turn an audit event into one plain sentence for a case's history.
 *
 * Built on the server so every client says the same thing, and so it can be
 * tested: the audit summary is free-form JSON, and a browser guessing at its
 * shape is how "undefined items added" ends up on screen.
 *
 * Unknown actions still produce something useful — the action name — rather than
 * an empty row, because the audit chain is append-only and older events may
 * predate whatever wording exists today.
 */
export function describeCaseEvent(action: string, summary: unknown): string {
  const s =
    typeof summary === 'object' && summary !== null ? (summary as Record<string, unknown>) : {};
  const num = (key: string): number | null =>
    typeof s[key] === 'number' ? (s[key] as number) : null;
  const str = (key: string): string | null =>
    typeof s[key] === 'string' ? (s[key] as string) : null;

  switch (action) {
    case 'case.created':
      return 'Case created';
    case 'case.updated':
      return 'Case details changed';
    case 'case.items_added': {
      const added = num('added');
      const requested = num('requested');
      const source = str('sourceKind');
      const from = source === null ? '' : ` from a ${source.replace('_', ' ')}`;
      if (added === null) return `Items added${from}`;
      const skipped = requested !== null && requested > added ? requested - added : 0;
      const base = `${String(added)} item${added === 1 ? '' : 's'} added${from}`;
      // Say when nothing changed: "0 added" reads like a failure otherwise.
      return skipped > 0 ? `${base} (${String(skipped)} already in the case)` : base;
    }
    case 'case.note_added':
      return 'Note added';
    case 'case.member_added': {
      const who = str('memberEmail') ?? str('email');
      return who === null ? 'Member added' : `${who} added to the case`;
    }
    case 'case.member_removed': {
      const who = str('memberEmail') ?? str('email');
      return who === null ? 'Member removed' : `${who} removed from the case`;
    }
    case 'case.hold_changed': {
      const on = s['legalHold'];
      const reason = str('reason');
      const state =
        on === true
          ? 'Legal hold placed'
          : on === false
            ? 'Legal hold lifted'
            : 'Legal hold changed';
      return reason === null || reason === '' ? state : `${state}: ${reason}`;
    }
    default:
      // e.g. export.created against this case, or an action added later.
      return action;
  }
}
