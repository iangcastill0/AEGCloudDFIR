'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button, Dialog, EmptyState, Table, TextInput } from '@evidencevault/ui';
import { QueryBoundary, StatusPill } from '@/components/shared';
import { useCases, useCreateCase } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

export default function CasesPage() {
  const cases = useCases();
  const createCase = useCreateCase();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [matterNumber, setMatterNumber] = useState('');
  const [client, setClient] = useState('');
  const [description, setDescription] = useState('');

  return (
    <>
      <div className="page-header">
        <h1>Cases</h1>
        <Button onClick={() => setOpen(true)}>New case</Button>
      </div>
      <QueryBoundary
        isPending={cases.isPending}
        error={cases.error}
        data={cases.data}
        onRetry={() => void cases.refetch()}
      >
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No cases"
              description="Cases group evidence references, saved searches, and holds for a matter."
              action={<Button onClick={() => setOpen(true)}>Create the first case</Button>}
            />
          ) : (
            <Table caption="Cases" captionHidden>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Matter</th>
                  <th scope="col">Client</th>
                  <th scope="col">Status</th>
                  <th scope="col">Legal hold</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/cases/${c.id}`}>{c.name}</Link>
                    </td>
                    <td>{c.matterNumber || '—'}</td>
                    <td>{c.client || '—'}</td>
                    <td>
                      <StatusPill status={c.status} />
                    </td>
                    <td>{c.legalHold ? 'On hold' : 'No hold'}</td>
                    <td>{formatDateTime(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryBoundary>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New case"
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={name.trim().length === 0}
              busy={createCase.isPending}
              onClick={() =>
                createCase.mutate(
                  { name: name.trim(), matterNumber, client, description },
                  { onSuccess: () => setOpen(false) },
                )
              }
            >
              Create case
            </Button>
          </>
        }
      >
        <TextInput label="Case name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput
          label="Matter number"
          value={matterNumber}
          onChange={(e) => setMatterNumber(e.target.value)}
        />
        <TextInput label="Client" value={client} onChange={(e) => setClient(e.target.value)} />
        <TextInput
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {createCase.isError ? (
          <p role="alert" className="ev-field__error">
            {errorMessage(createCase.error)}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
