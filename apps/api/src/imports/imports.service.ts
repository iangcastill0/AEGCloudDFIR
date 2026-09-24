import { Readable } from 'node:stream';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  TenantRole,
  withTenantContext,
  type PrismaClient,
  type TenantScopedTx,
} from '@aeg-clouddfir/database';
import {
  attachImportRequest,
  type ImportArtifact,
  type ImportSearchHit,
  type ImportSearchQuery,
  type ImportSummary,
} from '@aeg-clouddfir/contracts';
import type { EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import type { FastifyRequest } from 'fastify';
import '@fastify/multipart';
import type { AuthContext } from '../common/http.js';
import type { CursorQuery } from '../common/pagination.js';
import { EVIDENCE_STORE, PRISMA } from '../common/tokens.js';
import { zodValidate } from '../common/zod-validate.js';
import { AuditService } from '../audit/audit.service.js';
import { mayReadImport } from './import-access.js';

const ATTACH_PAGE = 1000;
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '7z',
  'archive',
  'csv',
  'db',
  'geojson',
  'gif',
  'gz',
  'heic',
  'jpeg',
  'jpg',
  'json',
  'log',
  'md',
  'pdf',
  'plist',
  'png',
  'sfl',
  'sqlite',
  'sqlite3',
  'tar',
  'tbz2',
  'tgz',
  'txt',
  'txz',
  'webp',
  'xml',
  'zip',
]);
const ARCHIVE_EXTENSIONS = new Set(['7z', 'gz', 'tar', 'tbz2', 'tgz', 'txz', 'zip']);

function sanitizeFilename(raw: string): string {
  const basename = raw.split(/[/\\]/).pop() ?? '';
  return basename
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, 255);
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
}

type ImportRow = {
  id: string;
  name: string;
  status: string;
  sourceEvidenceItemId: string;
  createdById: string;
  parserVersion: string;
  artifactCount: number;
  error: string;
  createdAt: Date;
  updatedAt: Date;
  cases: { caseId: string }[];
};

function toSummary(row: ImportRow): ImportSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status as ImportSummary['status'],
    sourceEvidenceItemId: row.sourceEvidenceItemId,
    createdById: row.createdById,
    parserVersion: row.parserVersion,
    artifactCount: row.artifactCount,
    error: row.error,
    caseIds: row.cases.map((entry) => entry.caseId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function boundedSnippet(value: string, query: string): string {
  const content = value.replace(/\s+/g, ' ').trim();
  const at = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (at < 0) return content.slice(0, 400);
  const start = Math.max(0, at - 120);
  const end = Math.min(content.length, start + 360);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`.slice(
    0,
    400,
  );
}

function matchSnippet(
  row: { name: string; path: string; textIndex: string },
  query: string,
): { matchLocation: ImportSearchHit['matchLocation']; snippet: string } {
  const needle = query.toLocaleLowerCase();
  if (row.name.toLocaleLowerCase().includes(needle)) {
    return { matchLocation: 'name', snippet: boundedSnippet(row.name, query) };
  }
  if (row.path.toLocaleLowerCase().includes(needle)) {
    return { matchLocation: 'path', snippet: boundedSnippet(row.path, query) };
  }
  return { matchLocation: 'content', snippet: boundedSnippet(row.textIndex, query) };
}

function escapeLikeQuery(query: string): string {
  return query.replace(/[\\%_]/g, '\\$&');
}

async function readJsonCapped(stream: Readable): Promise<unknown> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    seen += bytes.length;
    if (seen > PREVIEW_MAX_BYTES) throw new PayloadTooLargeException('preview is too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

@Injectable()
export class ImportsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVIDENCE_STORE) private readonly store: EvidenceObjectStore,
    private readonly audit: AuditService,
  ) {}

  private async requireImport(
    tx: TenantScopedTx,
    auth: AuthContext,
    id: string,
  ): Promise<ImportRow> {
    const row = await tx.forensicImport.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: {
        cases: {
          select: {
            caseId: true,
            case: { select: { members: { select: { membershipId: true } } } },
          },
        },
      },
    });
    if (row === null) throw new NotFoundException();
    const assigned = row.cases.some((entry) =>
      entry.case.members.some((member) => member.membershipId === auth.membershipId),
    );
    if (!mayReadImport(auth, row.createdById, assigned)) throw new NotFoundException();
    return {
      ...row,
      cases: row.cases.map((entry) => ({ caseId: entry.caseId })),
    };
  }

  async upload(auth: AuthContext, request: FastifyRequest): Promise<ImportSummary> {
    if (!request.isMultipart()) {
      throw new BadRequestException('expected a multipart/form-data request with one file part');
    }
    const part = await request.file();
    if (part === undefined) throw new BadRequestException('a file part is required');
    const filename = sanitizeFilename(part.filename);
    const extension = extensionOf(filename);
    if (filename === '' || !ALLOWED_EXTENSIONS.has(extension)) {
      throw new BadRequestException('this file type is not supported by the import viewer');
    }
    const staged = await this.store.stageStream(auth.tenantId, part.file);
    if (part.file.truncated) {
      throw new PayloadTooLargeException('the uploaded file exceeds the configured upload limit');
    }
    const promoted = await this.store.promoteToOriginal(auth.tenantId, staged.stagingKey, staged);

    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await tx.evidenceBlob.createMany({
        data: [
          {
            tenantId: auth.tenantId,
            sha256: staged.sha256,
            size: BigInt(staged.size),
            objectKey: promoted.objectKey,
          },
        ],
        skipDuplicates: true,
      });
      const blob = await tx.evidenceBlob.findUniqueOrThrow({
        where: { tenantId_sha256: { tenantId: auth.tenantId, sha256: staged.sha256 } },
        select: { id: true },
      });
      const evidence = await tx.evidenceItem.create({
        data: {
          tenantId: auth.tenantId,
          blobId: blob.id,
          kind: ARCHIVE_EXTENSIONS.has(extension) ? 'container' : 'file',
          provider: 'upload',
          name: filename,
          extension,
          mimeType: part.mimetype || 'application/octet-stream',
          size: BigInt(staged.size),
          sha256: staged.sha256,
          processingStatus: 'pending',
          processingDetail: 'forensic-import-source',
          sourcePath: `imports/${filename}`,
          acquiredAt: new Date(),
        },
        select: { id: true, version: true },
      });
      const created = await tx.forensicImport.create({
        data: {
          tenantId: auth.tenantId,
          sourceEvidenceItemId: evidence.id,
          createdById: auth.userId,
          name: filename,
        },
        include: { cases: { select: { caseId: true } } },
      });
      await tx.evidenceItem.update({
        where: { id: evidence.id },
        data: { importId: created.id },
      });
      await tx.outboxEvent.createMany({
        data: [
          {
            tenantId: auth.tenantId,
            topic: 'process.scan',
            dedupKey: `scan:${evidence.id}:v${evidence.version}`,
            payload: {
              tenantId: auth.tenantId,
              evidenceItemId: evidence.id,
              version: evidence.version,
            },
          },
        ],
        skipDuplicates: true,
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'import.uploaded',
        targetType: 'forensic_import',
        targetId: created.id,
        summary: { filename, sha256: staged.sha256, size: staged.size },
        request,
      });
      return created;
    });
    return toSummary(row);
  }

  async list(
    auth: AuthContext,
    page: CursorQuery,
  ): Promise<{ items: ImportSummary[]; nextCursor: string | null }> {
    const admin = auth.roles.includes(TenantRole.org_admin);
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.forensicImport.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(admin
            ? {}
            : {
                OR: [
                  { createdById: auth.userId },
                  {
                    cases: {
                      some: { case: { members: { some: { membershipId: auth.membershipId } } } },
                    },
                  },
                ],
              }),
        },
        include: { cases: { select: { caseId: true } } },
        orderBy: { id: 'asc' },
        take: page.limit + 1,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      }),
    );
    const visible = rows.slice(0, page.limit);
    return {
      items: visible.map(toSummary),
      nextCursor: rows.length > page.limit ? (visible.at(-1)?.id ?? null) : null,
    };
  }

  async detail(auth: AuthContext, id: string): Promise<ImportSummary> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) =>
      toSummary(await this.requireImport(tx, auth, id)),
    );
  }

  async artifacts(
    auth: AuthContext,
    id: string,
    page: CursorQuery,
  ): Promise<{ items: ImportArtifact[]; nextCursor: string | null }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireImport(tx, auth, id);
      const rows = await tx.importArtifact.findMany({
        where: { tenantId: auth.tenantId, importId: id },
        orderBy: { id: 'asc' },
        take: page.limit + 1,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      });
      const visible = rows.slice(0, page.limit);
      return {
        items: visible.map((row) => ({
          id: row.id,
          parentId: row.parentId,
          evidenceItemId: row.evidenceItemId,
          path: row.path,
          name: row.name,
          kind: row.kind as 'file' | 'directory',
          mimeType: row.mimeType,
          size: row.size.toString(),
          sha256: row.sha256,
          viewerType: row.viewerType,
          metadata: row.metadata as Record<string, unknown>,
          preview: null,
          textIndex: row.textIndex,
        })),
        nextCursor: rows.length > page.limit ? (visible.at(-1)?.id ?? null) : null,
      };
    });
  }

  async search(
    auth: AuthContext,
    id: string,
    input: ImportSearchQuery,
  ): Promise<{ items: ImportSearchHit[]; nextCursor: string | null }> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireImport(tx, auth, id);
      const literalQuery = escapeLikeQuery(input.q);
      const rows = await tx.importArtifact.findMany({
        where: {
          tenantId: auth.tenantId,
          importId: id,
          OR: [
            { name: { contains: literalQuery, mode: 'insensitive' } },
            { path: { contains: literalQuery, mode: 'insensitive' } },
            { textIndex: { contains: literalQuery, mode: 'insensitive' } },
          ],
        },
        orderBy: { id: 'asc' },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const visible = rows.slice(0, input.limit);
      return {
        items: visible.map((row) => ({
          artifact: {
            id: row.id,
            parentId: row.parentId,
            evidenceItemId: row.evidenceItemId,
            path: row.path,
            name: row.name,
            kind: row.kind as 'file' | 'directory',
            mimeType: row.mimeType,
            size: row.size.toString(),
            sha256: row.sha256,
            viewerType: row.viewerType,
            metadata: row.metadata as Record<string, unknown>,
          },
          ...matchSnippet(row, input.q),
        })),
        nextCursor: rows.length > input.limit ? (visible.at(-1)?.id ?? null) : null,
      };
    });
  }

  async artifact(auth: AuthContext, id: string, artifactId: string): Promise<ImportArtifact> {
    const row = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireImport(tx, auth, id);
      const found = await tx.importArtifact.findFirst({
        where: { id: artifactId, importId: id, tenantId: auth.tenantId },
      });
      if (found === null) throw new NotFoundException();
      return found;
    });
    const preview =
      row.previewKey === ''
        ? null
        : await readJsonCapped(await this.store.getStream('evidence', row.previewKey));
    return {
      id: row.id,
      parentId: row.parentId,
      evidenceItemId: row.evidenceItemId,
      path: row.path,
      name: row.name,
      kind: row.kind as 'file' | 'directory',
      mimeType: row.mimeType,
      size: row.size.toString(),
      sha256: row.sha256,
      viewerType: row.viewerType,
      metadata: row.metadata as Record<string, unknown>,
      preview,
      textIndex: row.textIndex,
    };
  }

  async retry(auth: AuthContext, id: string, request: FastifyRequest): Promise<ImportSummary> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      const current = await this.requireImport(tx, auth, id);
      const source = await tx.evidenceItem.findUniqueOrThrow({
        where: { id: current.sourceEvidenceItemId },
        select: { malwareStatus: true, version: true },
      });
      if (source.malwareStatus === 'infected') {
        throw new BadRequestException('a quarantined source cannot be analyzed');
      }
      await tx.forensicImport.update({
        where: { id },
        data: { status: 'uploaded', error: '' },
      });
      const needsScan = source.malwareStatus !== 'clean';
      const retryToken = Date.now();
      await tx.outboxEvent.create({
        data: {
          tenantId: auth.tenantId,
          topic: needsScan ? 'process.scan' : 'import.analyze',
          dedupKey: needsScan
            ? `scan:${current.sourceEvidenceItemId}:v${source.version}:retry${retryToken}`
            : `import:${id}:retry${retryToken}`,
          payload: needsScan
            ? {
                tenantId: auth.tenantId,
                evidenceItemId: current.sourceEvidenceItemId,
                version: source.version,
              }
            : { tenantId: auth.tenantId, importId: id },
        },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'import.retry_requested',
        targetType: 'forensic_import',
        targetId: id,
        summary: {},
        request,
      });
      return toSummary({ ...current, status: 'uploaded', error: '' });
    });
  }

  async attach(
    auth: AuthContext,
    id: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<{ importId: string; caseId: string; itemsAdded: number }> {
    const input = zodValidate(attachImportRequest, body);
    let itemsAdded = 0;
    await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      await this.requireImport(tx, auth, id);
      const targetCase = await tx.case.findFirst({
        where: { id: input.caseId, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (targetCase === null) throw new NotFoundException();
      await tx.importCase.createMany({
        data: [
          { tenantId: auth.tenantId, importId: id, caseId: input.caseId, addedById: auth.userId },
        ],
        skipDuplicates: true,
      });

      let cursor: string | undefined;
      for (;;) {
        const rows = await tx.evidenceItem.findMany({
          where: { tenantId: auth.tenantId, importId: id },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: ATTACH_PAGE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (rows.length === 0) break;
        const inserted = await tx.caseItem.createMany({
          data: rows.map((row) => ({
            tenantId: auth.tenantId,
            caseId: input.caseId,
            evidenceItemId: row.id,
            addedById: auth.userId,
            addedVia: 'import',
          })),
          skipDuplicates: true,
        });
        itemsAdded += inserted.count;
        cursor = rows.at(-1)?.id;
        if (rows.length < ATTACH_PAGE) break;
      }
      await tx.outboxEvent.createMany({
        data: [
          {
            tenantId: auth.tenantId,
            topic: 'search.case-import',
            dedupKey: `case-import:${id}:${input.caseId}`,
            payload: { tenantId: auth.tenantId, importId: id, caseId: input.caseId },
          },
        ],
        skipDuplicates: true,
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'import.attached_to_case',
        targetType: 'forensic_import',
        targetId: id,
        summary: { caseId: input.caseId, itemsAdded },
        request,
      });
    });
    return { importId: id, caseId: input.caseId, itemsAdded };
  }
}
