/**
 * Describe a connector in the account chooser.
 *
 * Four connectors to the same Yahoo mailbox once rendered as four identical
 * rows: the chooser showed only the identity and the mode, so nothing told them
 * apart and picking one was a guess. When the identity repeats, the label and
 * the date it was added are what distinguish them.
 */
export interface ChoosableConnector {
  id: string;
  provider: string;
  mode: string;
  label: string;
  externalIdentity: string;
  status: string;
  createdAt?: string;
}

/** The line shown against the radio button. */
export function connectorChoiceLabel(
  connector: ChoosableConnector,
  all: readonly ChoosableConnector[],
): string {
  const identity = connector.externalIdentity || connector.label || connector.id;
  const modeText = connector.mode === 'organization' ? '(organization)' : '(personal/delegated)';

  // Only add the disambiguator when it is actually needed; a single connector to
  // a mailbox reads better without a timestamp bolted on.
  const sameIdentity = all.filter(
    (c) => (c.externalIdentity || c.label || c.id) === identity,
  ).length;
  if (sameIdentity < 2) return `${identity} ${modeText}`;

  const added = connector.createdAt === undefined ? '' : shortStamp(connector.createdAt);
  const suffix = added === '' ? connector.id.slice(0, 8) : added;
  return `${identity} ${modeText} — added ${suffix}`;
}

/** A stamp precise enough to separate connectors created minutes apart. */
function shortStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
