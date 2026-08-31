/**
 * Say when a mail server refuses to show everything it holds.
 *
 * Measured against a real Yahoo mailbox on 2026-08-28: STATUS reported 113,039
 * messages in INBOX, SELECT reported EXISTS 10,000, and nothing below that
 * window could be reached by any means — not a date SEARCH, not an explicit UID
 * range, not a direct FETCH of a known UID. The walk collected 10,156 items,
 * which was exactly 100% of what the server offered, and the product then
 * described the result as "partial".
 *
 * That word was true and unhelpful. It reads as our failure, when the mail was
 * never offered. This turns the difference into a number a reviewer can act on:
 * how much exists, how much was available, and who decided.
 *
 * Pure on purpose — no server needed to test it.
 */
import type { ConnectorException } from '../types.js';

export interface FolderCoverage {
  /** Server path, used as the exception's providerItemId. */
  path: string;
  /** What STATUS said the mailbox holds. Undefined when it could not be read. */
  serverTotal?: number;
  /** What SELECT exposed (EXISTS). Undefined when it could not be read. */
  exposed?: number;
}

/** 1234567 -> "1,234,567". Long digit strings are unreadable in an exception. */
function group(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * An exception describing the withheld mail, or null when there is nothing to
 * report.
 *
 * Deliberately silent in three cases:
 *  - the server offered everything it has
 *  - `exposed` is larger, which just means mail arrived between the two round
 *    trips
 *  - either number is missing — a failed measurement is not evidence of a gap,
 *    and inventing one would put a false claim in a legal artefact
 *
 * There is no minimum gap. A one-message discrepancy could be a race between
 * STATUS and SELECT, but under-reporting missing evidence is the worse error of
 * the two, and the wording is factual rather than accusing.
 */
export function coverageException(input: FolderCoverage): ConnectorException | null {
  const { serverTotal, exposed } = input;
  if (serverTotal === undefined || exposed === undefined) return null;
  const withheld = serverTotal - exposed;
  if (withheld <= 0) return null;

  return {
    kind: 'unavailable_item',
    providerItemId: input.path,
    message:
      `The mail server reported ${group(serverTotal)} messages in ${input.path} but made only ` +
      `${group(exposed)} available over IMAP. ${group(withheld)} messages were not offered by ` +
      `the mail server and are therefore not in this collection. This is a limit set by the ` +
      `mail server, measured at the time of collection.`,
  };
}
