'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { Button, EmptyState, StatusLive, Table } from '@aeg-clouddfir/ui';
import { QueryBoundary, StatusPill } from '@/components/shared';
import { useImportUpload, useImports, useMe } from '@/lib/hooks';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

const ACCEPTED =
  '.zip,.7z,.tar,.tgz,.tbz2,.txz,.gz,.db,.sqlite,.sqlite3,.json,.geojson,.xml,.plist,.sfl,.archive,.pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.txt,.log,.csv,.md';

export default function ImportsPage() {
  const imports = useImports();
  const me = useMe();
  const upload = useImportUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const canUpload =
    me.data?.roles.some((role) => role === 'org_admin' || role === 'case_manager') ?? false;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setProgress(0);
    setStatus(`Uploading ${file.name}…`);
    try {
      const created = await upload.mutateAsync({
        file,
        onProgress: (fraction) => setProgress(fraction),
      });
      setStatus(`${created.name} is stored. Analysis has started.`);
    } catch (err) {
      setStatus(`Upload failed: ${errorMessage(err)}`);
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Imports</h1>
          <p>Open common forensic files while the unchanged source stays in evidence storage.</p>
        </div>
        {canUpload ? (
          <Button onClick={() => inputRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? `Uploading ${Math.round(progress * 100)}%` : 'New import'}
          </Button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          hidden
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </div>
      <StatusLive politeness="polite">{status}</StatusLive>
      <QueryBoundary
        isPending={imports.isPending}
        error={imports.error}
        data={imports.data}
        onRetry={() => void imports.refetch()}
      >
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title="No imports"
              description="Upload an archive, database, structured file, document, image, or log."
              action={
                canUpload ? (
                  <Button onClick={() => inputRef.current?.click()}>Choose a file</Button>
                ) : undefined
              }
            />
          ) : (
            <Table caption="Forensic imports" captionHidden>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Items</th>
                  <th scope="col">Cases</th>
                  <th scope="col">Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/import/${item.id}`}>{item.name}</Link>
                    </td>
                    <td>
                      <StatusPill status={item.status} />
                      {item.error ? <div className="cdfir-field__hint">{item.error}</div> : null}
                    </td>
                    <td>{item.artifactCount}</td>
                    <td>{item.caseIds.length}</td>
                    <td>{formatDateTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryBoundary>
    </>
  );
}
