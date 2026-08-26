/**
 * Map IMAP mailboxes onto the folder shape the rest of the app already speaks.
 *
 * Two things here are easy to get wrong and expensive to get wrong:
 *
 *  - The hierarchy delimiter is the SERVER's choice, not always '/'. Splitting
 *    on the wrong character turns 'INBOX.Projects.Q3' into one long folder name
 *    and loses the tree.
 *  - Well-known folders come from SPECIAL-USE flags, never from names. A trash
 *    folder called 'Papierkorb' is still the trash, and mislabelling deleted
 *    items changes what a reviewer believes about a collection.
 *
 * Pure: no server needed to test any of it.
 */
import type { ConnectorException, DiscoveredMailFolder, MailFolderDiscovery } from '../types.js';

export interface RawMailbox {
  /** Server path, e.g. 'INBOX.Projects.Q3'. This is what SELECT takes. */
  path: string;
  /** Hierarchy delimiter reported by the server. */
  delimiter: string;
  /** IMAP flags, including SPECIAL-USE ones like '\\Trash'. */
  flags: Set<string>;
  /** Message count when the server volunteers it. */
  exists?: number;
}

/**
 * SPECIAL-USE flag to the app's well-known name. The values match what the
 * Microsoft and Google connectors already emit, so downstream rules about
 * deleted items keep working across providers.
 */
const SPECIAL_USE: Record<string, string> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sentitems',
  '\\Trash': 'deleteditems',
  '\\Junk': 'junkemail',
  '\\Drafts': 'drafts',
  '\\Archive': 'archive',
  '\\All': 'allmail',
};

function wellKnownFor(box: RawMailbox): string | undefined {
  for (const [flag, name] of Object.entries(SPECIAL_USE)) {
    if (box.flags.has(flag)) return name;
  }
  // RFC 3501: INBOX is case-insensitive and always the inbox, and plenty of
  // servers never send \Inbox as a flag.
  if (box.path.toUpperCase() === 'INBOX') return 'inbox';
  return undefined;
}

function materializedPath(box: RawMailbox): string {
  const delimiter = box.delimiter === '' ? '/' : box.delimiter;
  const segments = box.path.split(delimiter).filter((s) => s !== '');
  return `/${segments.join('/')}`;
}

/** Folders to walk, plus anything skipped and the reason. Nothing is dropped silently. */
export function mapMailboxes(boxes: readonly RawMailbox[]): MailFolderDiscovery {
  const folders: DiscoveredMailFolder[] = [];
  const exceptions: ConnectorException[] = [];

  for (const box of boxes) {
    if (box.path === '') {
      exceptions.push({
        kind: 'unsupported_item',
        message: 'the server listed a mailbox with no path; it cannot be selected',
      });
      continue;
    }

    // \Noselect marks a container that holds no messages — only child
    // mailboxes. Listing it as a folder would imply we walked something we did
    // not.
    if (box.flags.has('\\Noselect') || box.flags.has('\\NonExistent')) {
      exceptions.push({
        kind: 'unsupported_item',
        message: `mailbox "${box.path}" cannot be selected (\\Noselect); it holds no messages of its own`,
      });
      continue;
    }

    const path = materializedPath(box);
    const segments = path.split('/').filter((s) => s !== '');
    const wellKnown = wellKnownFor(box);

    const folder: DiscoveredMailFolder = {
      // The raw path, because that is the string SELECT needs back.
      id: box.path,
      displayName: segments[segments.length - 1] ?? box.path,
      path,
    };
    if (wellKnown !== undefined) folder.wellKnown = wellKnown;
    if (box.exists !== undefined) folder.totalItemCount = box.exists;
    if (segments.length > 1) {
      folder.parentId = box.path.slice(0, box.path.lastIndexOf(box.delimiter || '/'));
    }
    folders.push(folder);
  }

  return { folders, exceptions };
}
