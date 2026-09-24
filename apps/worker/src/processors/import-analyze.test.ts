import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import tar from 'tar-stream';
import { EVIDENCE, TENANT, createManyRows, fakeCtx } from '../testing/fakes.js';
import { processImportAnalyze } from './import-analyze.js';

const IMPORT_ID = '99999999-9999-4999-8999-999999999999';

async function bundle(): Promise<Readable> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    pack.on('end', resolve);
    pack.on('error', reject);
  });
  const payload = Buffer.from('hello');
  const manifest = {
    contractVersion: 1,
    crushCommit: 'abc',
    sourceName: 'sample.zip',
    sourceSize: 10,
    warnings: [],
    limits: {},
    artifacts: [
      {
        id: '00000001',
        path: 'folder/file.txt',
        name: 'file.txt',
        size: payload.length,
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        payloadPath: 'payloads/00000001',
        viewerType: 'text',
        preview: { text: 'hello' },
        metadata: { Format: 'text' },
        textIndex: 'hello',
        parser: 'LogParser',
      },
    ],
  };
  pack.entry({ name: 'manifest.json' }, JSON.stringify(manifest));
  pack.entry({ name: 'payloads/00000001' }, payload);
  pack.finalize();
  await done;
  return Readable.from(Buffer.concat(chunks));
}

describe('processImportAnalyze', () => {
  it('preserves member bytes, writes preview metadata, and queues normal processing', async () => {
    const { ctx, tx, store } = fakeCtx({
      config: { CDFIR_CRUSH_PARSER_URL: 'http://crush.test:5200' },
    });
    tx.forensicImport.findUnique.mockResolvedValue({
      id: IMPORT_ID,
      name: 'sample.zip',
      status: 'uploaded',
      sourceEvidenceItemId: EVIDENCE,
      sourceEvidence: {
        id: EVIDENCE,
        malwareStatus: 'clean',
        blob: { objectKey: `tenants/${TENANT}/originals/source`, storageClass: 'standard' },
      },
      artifacts: [],
    });
    store.getStream.mockResolvedValue(Readable.from('archive'));
    store.stageStream.mockResolvedValue({
      stagingKey: `tenants/${TENANT}/staging/member`,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      size: 5,
    });
    tx.evidenceBlob.findUniqueOrThrow.mockResolvedValue({ id: 'blob-1' });
    tx.importArtifact.upsert.mockResolvedValue({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    tx.evidenceItem.create.mockImplementation(async ({ data }: { data: { id: string } }) => ({
      id: data.id,
      version: 1,
    }));

    await processImportAnalyze(
      ctx,
      { tenantId: TENANT, importId: IMPORT_ID },
      { analyze: vi.fn().mockResolvedValue(await bundle()) },
    );

    expect(store.stageStream).toHaveBeenCalledOnce();
    expect(store.promoteToOriginal).toHaveBeenCalledOnce();
    const evidenceId = (tx.evidenceItem.create.mock.calls[0]?.[0] as { data: { id: string } }).data
      .id;
    expect(store.putDerivative).toHaveBeenCalledWith(
      TENANT,
      evidenceId,
      'crush-preview',
      1,
      'preview.json',
      expect.anything(),
      'application/json',
    );
    expect(tx.importArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          importId: IMPORT_ID,
          parentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          path: 'folder/file.txt',
        }),
      }),
    );
    expect(tx.importArtifact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { importId_path: { importId: IMPORT_ID, path: 'folder' } },
        create: expect.objectContaining({ kind: 'directory', name: 'folder' }),
      }),
    );
    const outbox = createManyRows(tx.outboxEvent);
    expect(outbox.map((row) => row.topic)).toEqual(['process.scan']);
    expect(tx.forensicImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed', artifactCount: 1 }),
      }),
    );
  });

  it('returns without calling the parser when the import is already completed', async () => {
    const { ctx, tx } = fakeCtx();
    tx.forensicImport.findUnique.mockResolvedValue({
      id: IMPORT_ID,
      status: 'completed',
      sourceEvidence: null,
      artifacts: [],
    });
    const analyze = vi.fn();

    await processImportAnalyze(ctx, { tenantId: TENANT, importId: IMPORT_ID }, { analyze });

    expect(analyze).not.toHaveBeenCalled();
  });

  it('does not expose an unscanned source to the parser', async () => {
    const { ctx, tx } = fakeCtx();
    tx.forensicImport.findUnique.mockResolvedValue({
      id: IMPORT_ID,
      name: 'sample.zip',
      status: 'uploaded',
      sourceEvidenceItemId: EVIDENCE,
      sourceEvidence: {
        id: EVIDENCE,
        malwareStatus: 'not_scanned',
        blob: { objectKey: 'source', storageClass: 'standard' },
      },
      artifacts: [],
    });
    const analyze = vi.fn();

    await expect(
      processImportAnalyze(ctx, { tenantId: TENANT, importId: IMPORT_ID }, { analyze }),
    ).rejects.toThrow('waiting for source malware scan');
    expect(analyze).not.toHaveBeenCalled();
  });
});
