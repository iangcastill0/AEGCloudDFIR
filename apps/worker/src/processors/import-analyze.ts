import { randomUUID } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import { appendAuditEvent, Prisma, withTenantContext } from '@aeg-clouddfir/database';
import tar from 'tar-stream';
import { z } from 'zod';
import { sanitizeError, type WorkerContext } from '../context.js';
import { readAllCapped } from '../streams.js';
import { QUEUES, dedupKeys } from '../queues.js';
import type { ImportAnalyzePayload } from './payloads.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const artifactSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).max(2000),
  name: z.string().min(1).max(500),
  size: z.number().int().nonnegative(),
  sha256,
  payloadPath: z.string().nullable(),
  viewerType: z.string().max(64),
  preview: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  textIndex: z.string().default(''),
  parser: z.string().default(''),
});
const manifestSchema = z.object({
  contractVersion: z.literal(1),
  crushCommit: z.string().min(1),
  sourceName: z.string().min(1),
  sourceSize: z.number().int().nonnegative(),
  artifacts: z.array(artifactSchema),
  warnings: z.array(z.unknown()).default([]),
  limits: z.record(z.string(), z.unknown()).default({}),
});
type Manifest = z.infer<typeof manifestSchema>;
type Artifact = z.infer<typeof artifactSchema>;

export interface ImportAnalyzeDeps {
  analyze?: (source: Readable, filename: string, ctx: WorkerContext) => Promise<Readable>;
}

async function callParser(
  source: Readable,
  filename: string,
  ctx: WorkerContext,
): Promise<Readable> {
  const headerFilename = filename.replace(/[^\x20-\x7e]/g, '_');
  const response = await fetch(`${ctx.config.CDFIR_CRUSH_PARSER_URL}/v1/analyze`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-source-filename': headerFilename,
      'x-max-preview-rows': String(ctx.config.CDFIR_IMPORT_PREVIEW_ROWS),
    },
    body: source,
    duplex: 'half',
    signal: AbortSignal.timeout(ctx.config.CDFIR_CRUSH_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Crush parser returned ${response.status}: ${detail.slice(0, 500)}`);
  }
  return Readable.fromWeb(response.body);
}

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at > 0 ? name.slice(at + 1).toLowerCase() : '';
}

function mimeTypeFor(name: string): string {
  const ext = extensionOf(name);
  const known: Record<string, string> = {
    csv: 'text/csv',
    gif: 'image/gif',
    json: 'application/json',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    log: 'text/plain',
    pdf: 'application/pdf',
    plist: 'application/x-plist',
    png: 'image/png',
    sqlite: 'application/vnd.sqlite3',
    sqlite3: 'application/vnd.sqlite3',
    db: 'application/vnd.sqlite3',
    txt: 'text/plain',
    webp: 'image/webp',
    xml: 'application/xml',
  };
  return known[ext] ?? 'application/octet-stream';
}

async function persistPreview(
  ctx: WorkerContext,
  tenantId: string,
  evidenceItemId: string,
  artifact: Artifact,
): Promise<{ objectKey: string; sha256: string }> {
  const bytes = Buffer.from(JSON.stringify(artifact.preview), 'utf8');
  return ctx.store.putDerivative(
    tenantId,
    evidenceItemId,
    'crush-preview',
    1,
    'preview.json',
    bytes,
    'application/json',
  );
}

async function persistPayload(
  ctx: WorkerContext,
  input: {
    tenantId: string;
    importId: string;
    sourceEvidenceItemId: string;
    artifact: Artifact;
    stream: Readable;
  },
): Promise<void> {
  const { tenantId, importId, sourceEvidenceItemId, artifact, stream } = input;
  const staged = await ctx.store.stageStream(tenantId, stream);
  if (staged.sha256 !== artifact.sha256 || staged.size !== artifact.size) {
    throw new Error(`parser payload hash/size mismatch for ${artifact.path}`);
  }
  const promoted = await ctx.store.promoteToOriginal(tenantId, staged.stagingKey, staged);
  const evidenceItemId = randomUUID();
  const preview = await persistPreview(ctx, tenantId, evidenceItemId, artifact);

  await withTenantContext(ctx.prisma, tenantId, async (tx) => {
    await tx.evidenceBlob.createMany({
      data: [
        {
          tenantId,
          sha256: staged.sha256,
          size: BigInt(staged.size),
          objectKey: promoted.objectKey,
        },
      ],
      skipDuplicates: true,
    });
    const blob = await tx.evidenceBlob.findUniqueOrThrow({
      where: { tenantId_sha256: { tenantId, sha256: staged.sha256 } },
      select: { id: true },
    });
    const created = await tx.evidenceItem.create({
      data: {
        id: evidenceItemId,
        tenantId,
        importId,
        blobId: blob.id,
        kind: 'file',
        provider: 'upload',
        name: artifact.name,
        extension: extensionOf(artifact.name),
        mimeType: mimeTypeFor(artifact.name),
        size: BigInt(staged.size),
        sha256: staged.sha256,
        sourcePath: artifact.path,
        processingStatus: 'pending',
        processingDetail: 'extracted-from-crush-container',
        acquiredAt: new Date(),
      },
      select: { id: true, version: true },
    });
    await tx.evidenceRelationship.createMany({
      data: [
        {
          tenantId,
          parentId: sourceEvidenceItemId,
          childId: created.id,
          kind: 'container_member',
          detail: artifact.path,
        },
      ],
      skipDuplicates: true,
    });
    const attachedCases = await tx.importCase.findMany({
      where: { tenantId, importId },
      select: { caseId: true, addedById: true },
    });
    if (attachedCases.length > 0) {
      await tx.caseItem.createMany({
        data: attachedCases.map((entry) => ({
          tenantId,
          caseId: entry.caseId,
          evidenceItemId: created.id,
          addedById: entry.addedById,
          addedVia: 'import',
        })),
        skipDuplicates: true,
      });
    }
    const pathParts = artifact.path.split('/').filter((part) => part.length > 0);
    let parentId: string | null = null;
    for (let index = 0; index < pathParts.length - 1; index += 1) {
      const directoryPath = pathParts.slice(0, index + 1).join('/');
      const directory: { id: string } = await tx.importArtifact.upsert({
        where: { importId_path: { importId, path: directoryPath } },
        create: {
          tenantId,
          importId,
          parentId,
          path: directoryPath,
          name: pathParts[index]!,
          kind: 'directory',
        },
        update: {},
        select: { id: true },
      });
      parentId = directory.id;
    }
    await tx.importArtifact.create({
      data: {
        tenantId,
        importId,
        parentId,
        evidenceItemId: created.id,
        path: artifact.path,
        name: artifact.name,
        kind: 'file',
        mimeType: mimeTypeFor(artifact.name),
        size: BigInt(artifact.size),
        sha256: artifact.sha256,
        viewerType: artifact.viewerType,
        metadata: artifact.metadata as Prisma.InputJsonValue,
        previewKey: preview.objectKey,
        previewSha256: preview.sha256,
        textIndex: artifact.textIndex.slice(0, 100_000),
      },
    });
    await tx.outboxEvent.createMany({
      data: [
        {
          tenantId,
          topic: QUEUES.processScan,
          dedupKey: dedupKeys.processStage('scan', created.id, created.version),
          payload: { tenantId, evidenceItemId: created.id, version: created.version },
        },
      ],
      skipDuplicates: true,
    });
  });
}

async function unpackBundle(
  ctx: WorkerContext,
  payload: ImportAnalyzePayload,
  sourceEvidenceItemId: string,
  bundle: Readable,
  existingPaths: Set<string>,
): Promise<Manifest> {
  const extract = tar.extract();
  let manifest: Manifest | undefined;
  const byPayload = new Map<string, Artifact>();
  const processing = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      void (async () => {
        if (header.name === 'manifest.json') {
          manifest = manifestSchema.parse(
            JSON.parse(
              (await readAllCapped(stream as unknown as Readable, 32 * 1024 * 1024)).toString(
                'utf8',
              ),
            ),
          );
          for (const artifact of manifest.artifacts) {
            if (artifact.payloadPath !== null) byPayload.set(artifact.payloadPath, artifact);
          }
        } else {
          const artifact = byPayload.get(header.name);
          if (artifact === undefined || existingPaths.has(artifact.path)) {
            stream.resume();
            await new Promise<void>((done, fail) => {
              stream.on('end', done);
              stream.on('error', fail);
            });
          } else {
            await persistPayload(ctx, {
              tenantId: payload.tenantId,
              importId: payload.importId,
              sourceEvidenceItemId,
              artifact,
              stream: stream as unknown as Readable,
            });
            existingPaths.add(artifact.path);
          }
        }
        next();
      })().catch(reject);
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
  });
  bundle.pipe(extract as unknown as Writable);
  await processing;
  if (manifest === undefined) throw new Error('Crush response did not contain manifest.json');
  return manifest;
}

export async function processImportAnalyze(
  ctx: WorkerContext,
  payload: ImportAnalyzePayload,
  deps: ImportAnalyzeDeps = {},
): Promise<void> {
  const row = await withTenantContext(ctx.prisma, payload.tenantId, (tx) =>
    tx.forensicImport.findUnique({
      where: { id: payload.importId },
      include: {
        sourceEvidence: { include: { blob: true } },
        artifacts: { select: { path: true } },
      },
    }),
  );
  if (row === null) {
    ctx.log.warn({ importId: payload.importId }, 'import analyze: import not found; dropping');
    return;
  }
  if (row.status === 'completed') return;
  if (row.sourceEvidence?.blob === null || row.sourceEvidence === null) {
    throw new Error('import source has no preserved object');
  }
  if (row.sourceEvidence.malwareStatus === 'infected') {
    await withTenantContext(ctx.prisma, payload.tenantId, async (tx) => {
      await tx.forensicImport.update({
        where: { id: payload.importId },
        data: { status: 'failed', error: 'source was quarantined as malware' },
      });
      await appendAuditEvent(tx, {
        tenantId: payload.tenantId,
        action: 'import.analysis_failed',
        targetType: 'forensic_import',
        targetId: payload.importId,
        actorDisplay: 'worker',
        summary: { error: 'source was quarantined as malware' },
      });
    });
    return;
  }
  if (ctx.config.CDFIR_CLAMAV_ENABLED && row.sourceEvidence.malwareStatus === 'not_scanned') {
    throw new Error('waiting for source malware scan');
  }
  if (ctx.config.CDFIR_CLAMAV_ENABLED && row.sourceEvidence.malwareStatus === 'scan_failed') {
    await withTenantContext(ctx.prisma, payload.tenantId, async (tx) => {
      await tx.forensicImport.update({
        where: { id: payload.importId },
        data: { status: 'failed', error: 'source malware scan did not complete' },
      });
      await appendAuditEvent(tx, {
        tenantId: payload.tenantId,
        action: 'import.analysis_failed',
        targetType: 'forensic_import',
        targetId: payload.importId,
        actorDisplay: 'worker',
        summary: { error: 'source malware scan did not complete' },
      });
    });
    return;
  }

  await withTenantContext(ctx.prisma, payload.tenantId, (tx) =>
    tx.forensicImport.update({
      where: { id: payload.importId },
      data: { status: 'analyzing', error: '' },
    }),
  );

  try {
    const source = await ctx.store.getStream(
      row.sourceEvidence.blob.storageClass === 'quarantine' ? 'quarantine' : 'evidence',
      row.sourceEvidence.blob.objectKey,
    );
    const analyze = deps.analyze ?? callParser;
    const bundle = await analyze(source, row.name, ctx);
    const existingPaths = new Set(row.artifacts.map((artifact) => artifact.path));
    const manifest = await unpackBundle(
      ctx,
      payload,
      row.sourceEvidenceItemId,
      bundle,
      existingPaths,
    );

    for (const artifact of manifest.artifacts.filter((item) => item.payloadPath === null)) {
      if (existingPaths.has(artifact.path)) continue;
      const preview = await persistPreview(
        ctx,
        payload.tenantId,
        row.sourceEvidenceItemId,
        artifact,
      );
      await withTenantContext(ctx.prisma, payload.tenantId, async (tx) => {
        await tx.importArtifact.create({
          data: {
            tenantId: payload.tenantId,
            importId: payload.importId,
            evidenceItemId: row.sourceEvidenceItemId,
            path: artifact.path,
            name: artifact.name,
            kind: 'file',
            mimeType: mimeTypeFor(artifact.name),
            size: BigInt(artifact.size),
            sha256: artifact.sha256,
            viewerType: artifact.viewerType,
            metadata: artifact.metadata as Prisma.InputJsonValue,
            previewKey: preview.objectKey,
            previewSha256: preview.sha256,
            textIndex: artifact.textIndex.slice(0, 100_000),
          },
        });
        await tx.outboxEvent.createMany({
          data: [
            {
              tenantId: payload.tenantId,
              topic: QUEUES.processExtract,
              dedupKey: dedupKeys.processStage('extract', row.sourceEvidenceItemId, 1),
              payload: {
                tenantId: payload.tenantId,
                evidenceItemId: row.sourceEvidenceItemId,
                version: 1,
              },
            },
            {
              tenantId: payload.tenantId,
              topic: QUEUES.processPreview,
              dedupKey: dedupKeys.processStage('preview', row.sourceEvidenceItemId, 1),
              payload: {
                tenantId: payload.tenantId,
                evidenceItemId: row.sourceEvidenceItemId,
                version: 1,
              },
            },
            {
              tenantId: payload.tenantId,
              topic: QUEUES.searchIndex,
              dedupKey: dedupKeys.searchIndex(row.sourceEvidenceItemId, 1, 'import'),
              payload: {
                tenantId: payload.tenantId,
                evidenceItemId: row.sourceEvidenceItemId,
                version: 1,
              },
            },
          ],
          skipDuplicates: true,
        });
      });
    }

    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const storedManifest = await ctx.store.putDerivative(
      payload.tenantId,
      row.sourceEvidenceItemId,
      'crush-manifest',
      1,
      'manifest.json',
      manifestBytes,
      'application/json',
    );
    await withTenantContext(ctx.prisma, payload.tenantId, async (tx) => {
      await tx.forensicImport.update({
        where: { id: payload.importId },
        data: {
          status: 'completed',
          parserVersion: `crush@${manifest.crushCommit}`,
          manifestKey: storedManifest.objectKey,
          manifestSha256: storedManifest.sha256,
          artifactCount: manifest.artifacts.length,
          error: '',
        },
      });
      await appendAuditEvent(tx, {
        tenantId: payload.tenantId,
        action: 'import.analysis_completed',
        targetType: 'forensic_import',
        targetId: payload.importId,
        actorDisplay: 'worker',
        summary: {
          sourceEvidenceItemId: row.sourceEvidenceItemId,
          artifactCount: manifest.artifacts.length,
          warnings: manifest.warnings.length,
          parserVersion: `crush@${manifest.crushCommit}`,
        },
      });
    });
  } catch (err) {
    await withTenantContext(ctx.prisma, payload.tenantId, async (tx) => {
      await tx.forensicImport.update({
        where: { id: payload.importId },
        data: { status: 'failed', error: sanitizeError(err) },
      });
      await appendAuditEvent(tx, {
        tenantId: payload.tenantId,
        action: 'import.analysis_failed',
        targetType: 'forensic_import',
        targetId: payload.importId,
        actorDisplay: 'worker',
        summary: { error: sanitizeError(err) },
      });
    });
    throw err;
  }
}
