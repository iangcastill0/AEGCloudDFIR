/**
 * Build the IMAP connector request from what the operator typed.
 *
 * Pure, and validated against the API's own schema, for the same reason the
 * other connector builders are: the last three connector bugs were all a browser
 * payload that did not match what the API validates.
 */
import {
  IMAP_PRESETS,
  createImapConnectorRequest,
  type CreateImapConnectorRequest,
} from '@aeg-clouddfir/contracts';

export type ImapPreset = (typeof IMAP_PRESETS)[number];

/** The preset with this id, or null for a custom server. */
export function imapPresetById(id: string): ImapPreset | null {
  return IMAP_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * A name for the connection before anything has been collected.
 *
 * The mailbox address is the useful part; the date separates repeat attempts on
 * the same mailbox.
 */
export function defaultImapLabel(username: string, now: Date): string {
  const when = now.toISOString().slice(0, 10);
  return `${username.trim()} (IMAP) ${when}`;
}

export function buildImapConnector(input: {
  presetId: string;
  label: string;
  username: string;
  appPassword: string;
  /** Only used when the preset is 'custom'. */
  host: string;
  port: string;
  now?: Date;
}): CreateImapConnectorRequest {
  const preset = imapPresetById(input.presetId);
  const username = input.username.trim();

  // A preset carries its own host, port and TLS setting; a custom server takes
  // them from the form. Port 143 means STARTTLS rather than implicit TLS — the
  // one place where a number changes the security of the connection, so it is
  // derived here rather than left to a checkbox nobody reads.
  const host = preset === null ? input.host.trim() : preset.host;
  const port = preset === null ? Number(input.port.trim()) : preset.port;
  const secure = preset === null ? port !== 143 : preset.secure;

  const label =
    input.label.trim() === ''
      ? defaultImapLabel(username, input.now ?? new Date())
      : input.label.trim();

  return createImapConnectorRequest.parse({
    label,
    host,
    port,
    secure,
    username,
    appPassword: input.appPassword,
  });
}
