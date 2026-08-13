import { BadRequestException, Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { withTenantContext, type PrismaClient } from '@aeg-clouddfir/database';
import type { EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import type { FastifyRequest } from 'fastify';
import '@fastify/multipart';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { EVIDENCE_STORE, PRISMA } from '../common/tokens.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Mailbox container uploads. The uploaded file is preserved byte-for-byte as
 * an immutable, content-addressed original (EvidenceItem kind 'container',
 * synthetic provider 'upload'). Message extraction happens later, in the
 * worker, as clearly-labeled reconstructions — this endpoint never inspects
 * or mutates the container bytes, only streams and hashes them.
 */

/** Accepted container extensions. Everything else is rejected up front. */
export const ALLOWED_UPLOAD_EXTENSIONS = ['pst', 'ost'] as const;

const PST_MIME_TYPE = 'application/vnd.ms-outlook-pst';

export interface UploadResult {
  uploadId: string;
  filename: string;
  sha256: string;
  size: number;
}

/** Strip any path components / control characters; keep a plain basename. */
export function sanitizeFilename(raw: string): string {
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
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

@Injectable()
export class UploadsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EVIDENCE_STORE) private readonly store: EvidenceObjectStore,
    private readonly audit: AuditService,
  ) {}

  async upload(auth: AuthContext, request: FastifyRequest): Promise<UploadResult> {
    if (!request.isMultipart()) {
      throw new BadRequestException('expected a multipart/form-data request with one file part');
    }
    const part = await request.file();
    if (part === undefined) {
      throw new BadRequestException('a file part is required');
    }

    const filename = sanitizeFilename(part.filename);
    const extension = extensionOf(filename);
    if (filename === '' || !(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
      throw new BadRequestException(
        'only .pst and .ost mailbox container files are accepted for upload',
      );
    }

    // Stream straight into staging while hashing — the file is NEVER buffered
    // in API memory. Verification + promotion make the original immutable.
    const staged = await this.store.stageStream(auth.tenantId, part.file);
    if (part.file.truncated) {
      throw new PayloadTooLargeException(
        'the uploaded file exceeds the configured upload size limit',
      );
    }
    const promoted = await this.store.promoteToOriginal(auth.tenantId, staged.stagingKey, {
      sha256: staged.sha256,
      size: staged.size,
    });

    const mimeType =
      extension === 'pst' || extension === 'ost'
        ? PST_MIME_TYPE
        : part.mimetype || 'application/octet-stream';

    const uploadId = await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
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
          kind: 'container',
          provider: 'upload',
          name: filename,
          extension,
          mimeType,
          size: BigInt(staged.size),
          sha256: staged.sha256,
          processingStatus: 'pending',
          sourcePath: `uploads/${filename}`,
          acquiredAt: new Date(),
        },
        select: { id: true },
      });
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'evidence.uploaded',
        targetType: 'evidence_item',
        targetId: evidence.id,
        summary: { filename, sha256: staged.sha256, size: staged.size },
        request,
      });
      return evidence.id;
    });

    return { uploadId, filename, sha256: staged.sha256, size: staged.size };
  }
}
