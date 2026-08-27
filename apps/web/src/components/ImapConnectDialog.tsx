'use client';
import { useState } from 'react';
import { Button, Dialog, Notice, Select, TextInput } from '@aeg-clouddfir/ui';
import { IMAP_PRESETS } from '@aeg-clouddfir/contracts';
import { useCreateImapConnector } from '@/lib/hooks';
import { buildImapConnector, imapPresetById } from '@/lib/imap-setup';
import { errorMessage } from '@/lib/errors';

/**
 * Connect a mailbox by IMAP.
 *
 * Presets exist because nobody remembers IMAP hostnames, and a typo produces a
 * connection error that reads like a wrong password. "Other" is there because a
 * client's own mail server is a normal thing to collect from.
 */
export function ImapConnectDialog({
  onClose,
  onStatus,
}: {
  onClose: () => void;
  onStatus: (text: string) => void;
}) {
  const create = useCreateImapConnector();
  const [presetId, setPresetId] = useState<string>('yahoo');
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [error, setError] = useState('');

  const preset = imapPresetById(presetId);
  const custom = preset === null;

  function submit() {
    setError('');
    let body;
    try {
      body = buildImapConnector({
        presetId,
        label,
        username,
        appPassword,
        host,
        port,
      });
    } catch {
      setError('Check the fields above: something is missing or not in the expected form.');
      return;
    }
    create.mutate(body, {
      onSuccess: () => {
        onStatus(
          'Mailbox connected. Use Test on the connector to confirm the credential reaches the server.',
        );
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Connect a mailbox by IMAP"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} busy={create.isPending}>
            Connect mailbox
          </Button>
        </>
      }
    >
      <Notice variant="warning">
        Use an <strong>app password</strong>, not the account password. Yahoo, iCloud and Gmail all
        refuse the account password over IMAP. Generate one in the mail account&apos;s security
        settings.
      </Notice>

      <Select
        label="Mail provider"
        value={presetId}
        onChange={(e) => setPresetId(e.target.value)}
        options={[
          ...IMAP_PRESETS.map((p) => ({ value: p.id, label: p.label })),
          { value: 'custom', label: 'Other (enter the server myself)' },
        ]}
      />

      {custom ? (
        <>
          <TextInput
            label="IMAP server"
            hint="For example imap.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          <TextInput
            label="Port"
            hint="993 for TLS, which is almost always right. 143 means STARTTLS."
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </>
      ) : (
        <p className="cdfir-field__hint">
          Server: <span className="mono">{preset.host}</span> port{' '}
          <span className="mono">{String(preset.port)}</span> over TLS.
        </p>
      )}

      <TextInput
        label="Email address"
        hint="The mailbox to collect. This is also the IMAP username."
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <TextInput
        label="App password"
        type="password"
        hint="Stored encrypted. It is never shown again after this."
        value={appPassword}
        onChange={(e) => setAppPassword(e.target.value)}
      />
      <TextInput
        label="Label (optional)"
        hint="A name for this connection. Left blank, the email address and today's date are used."
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />

      {error === '' ? null : (
        <p role="alert" className="cdfir-field__error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
