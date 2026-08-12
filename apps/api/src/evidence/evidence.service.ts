import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AppConfig } from '@aeg-clouddfir/config';
import {
  EvidenceKind,
  MalwareStatus,
  TenantRole,
  withTenantContext,
  type PrismaClient,
  type TenantScopedTx,
} from '@aeg-clouddfir/database';
import type { EvidenceObjectStore } from '@aeg-clouddfir/evidence';
import { TRUTHFULNESS_NOTICES } from '@aeg-clouddfir/contracts';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import type { AuthContext } from '../common/http.js';
import { APP_CONFIG, EVIDENCE_STORE, PRISMA } from '../common/tokens.js';
import { isCaseRestricted } from '../common/roles.js';
import { AuditService } from '../audit/audit.service.js';

const PREVIEW_SAFETY_NOTE =
  'Previews are rendered offline and never load remote content (images, trackers, scripts).';

export interface AuditRecordDto {
  id: string;
  system: string;
  providerRecordId: string;
  workload: string;
  operation: string;
  recordType: string;
  actorId: string;
  actorEmail: string;
  actorIp: string;
  targetId: string;
  targetType: string;
  resultStatus: string;
  occurredAt: string | null;
  raw: unknown;
}

export interface EvidenceDetailDto {
  id: string;
  kind: string;
  name: string;
  extension: string;
  mimeType: string;
  size: string;
  sha256: string;
  custodianEmail: string | null;
  sourcePath: string;
  sourceLabels: string[];
  primaryDate: string | null;
  acquiredAt: string;
  processingStatus: string;
  processingDetail: string;
  malwareStatus: string;
  isApiExportDerivative: boolean;
  provider: string | null;
  tags: { id: string; name: string; color: string }[];
  emailMetadata: Record<string, unknown> | null;
  driveMetadata: Record<string, unknown> | null;
  notices: string[];
}

@Injectable()
export class EvidenceService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EVIDENCE_STORE) private readonly store: EvidenceObjectStore,
    private readonly audit: AuditService,
  ) {}

  /**
   * Load an item, enforcing tenant scope and — for case-restricted callers —
   * membership of at least one assigned case. Both misses are a plain 404 so
   * cross-tenant probing is indistinguishable from a missing id.
   */
  private async requireItem<T>(
    auth: AuthContext,
    id: string,
    loader: (tx: TenantScopedTx) => Promise<T | null>,
  ): Promise<T> {
    return withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      if (isCaseRestricted(auth)) {
        const visible = await tx.caseItem.count({
          where: {
            tenantId: auth.tenantId,
            evidenceItemId: id,
            case: { members: { some: { membershipId: auth.membershipId } } },
          },
        });
        if (visible === 0) throw new NotFoundException();
      }
      const row = await loader(tx);
      if (row === null) throw new NotFoundException();
      return row;
    });
  }

  async detail(auth: AuthContext, id: string): Promise<EvidenceDetailDto> {
    const item = await this.requireItem(auth, id, (tx) =>
      tx.evidenceItem.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: {
          custodian: { select: { email: true } },
          emailMetadata: true,
          driveMetadata: true,
          tagAssignments: { include: { tag: { select: { id: true, name: true, color: true } } } },
        },
      }),
    );

    const notices: string[] = [];
    if (item.isApiExportDerivative) notices.push(TRUTHFULNESS_NOTICES.googleNativeExports);
    if (item.emailMetadata) notices.push(TRUTHFULNESS_NOTICES.bcc);

    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      extension: item.extension,
      mimeType: item.mimeType,
      size: item.size.toString(),
      sha256: item.sha256,
      custodianEmail: item.custodian?.email ?? null,
      sourcePath: item.sourcePath,
      sourceLabels: item.sourceLabels,
      primaryDate: item.primaryDate?.toISOString() ?? null,
      acquiredAt: item.acquiredAt.toISOString(),
      processingStatus: item.processingStatus,
      processingDetail: item.processingDetail,
      malwareStatus: item.malwareStatus,
      isApiExportDerivative: item.isApiExportDerivative,
      provider: item.provider,
      tags: item.tagAssignments.map((a) => a.tag),
      emailMetadata: item.emailMetadata
        ? {
            subject: item.emailMetadata.subject,
            messageId: item.emailMetadata.messageId,
            inReplyTo: item.emailMetadata.inReplyTo,
            threadId: item.emailMetadata.threadId,
            conversationId: item.emailMetadata.conversationId,
            sentAt: item.emailMetadata.sentAt?.toISOString() ?? null,
            receivedAt: item.emailMetadata.receivedAt?.toISOString() ?? null,
            rawDateHeader: item.emailMetadata.rawDateHeader,
            folder: item.emailMetadata.folder,
            labels: item.emailMetadata.labels,
            categories: item.emailMetadata.categories,
            flags: item.emailMetadata.flags,
            bccPresent: item.emailMetadata.bccPresent,
            hasAttachments: item.emailMetadata.hasAttachments,
            isEncrypted: item.emailMetadata.isEncrypted,
            smimeType: item.emailMetadata.smimeType,
          }
        : null,
      driveMetadata: item.driveMetadata
        ? {
            driveId: item.driveMetadata.driveId,
            driveName: item.driveMetadata.driveName,
            path: item.driveMetadata.path,
            webUrl: item.driveMetadata.webUrl,
            isTrashed: item.driveMetadata.isTrashed,
            isSharedDrive: item.driveMetadata.isSharedDrive,
            sourceNativeMimeType: item.driveMetadata.sourceNativeMimeType,
            exportFormat: item.driveMetadata.exportFormat,
            revisionCount: item.driveMetadata.revisionCount,
          }
        : null,
      notices,
    };
  }

  async headers(
    auth: AuthContext,
    id: string,
  ): Promise<{ items: { name: string; rawName: string; value: string; position: number }[] }> {
    const item = await this.requireItem(auth, id, (tx) =>
      tx.evidenceItem.findFirst({ where: { id, tenantId: auth.tenantId }, select: { id: true } }),
    );
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.header.findMany({
        where: { tenantId: auth.tenantId, evidenceItemId: item.id },
        orderBy: { position: 'asc' },
        select: { name: true, rawName: true, value: true, position: true },
      }),
    );
    return { items: rows };
  }

  /**
   * Parsed audit records for an audit_batch evidence item, cursor-paginated.
   * Non-audit or foreign ids are an indistinguishable 404 (requireItem enforces
   * tenant scope and case-membership ACL; the kind filter hides non-audit ids).
   */
  async auditRecords(
    auth: AuthContext,
    id: string,
    page: { cursor?: string; limit: number },
  ): Promise<{
    items: AuditRecordDto[];
    nextCursor: string | null;
    batch: { id: string; name: string; sha256: string };
  }> {
    const item = await this.requireItem(auth, id, (tx) =>
      tx.evidenceItem.findFirst({
        where: { id, tenantId: auth.tenantId, kind: EvidenceKind.audit_batch },
        select: { id: true, name: true, sha256: true },
      }),
    );
    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.auditRecord.findMany({
        where: { tenantId: auth.tenantId, evidenceItemId: item.id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      }),
    );
    const slice = rows.slice(0, page.limit);
    const last = slice[slice.length - 1];
    return {
      items: slice.map((r) => ({
        id: r.id,
        system: r.system,
        providerRecordId: r.providerRecordId,
        workload: r.workload,
        operation: r.operation,
        recordType: r.recordType,
        actorId: r.actorId,
        actorEmail: r.actorEmail,
        actorIp: r.actorIp,
        targetId: r.targetId,
        targetType: r.targetType,
        resultStatus: r.resultStatus,
        occurredAt: r.occurredAt?.toISOString() ?? null,
        raw: r.raw,
      })),
      nextCursor: rows.length > page.limit && last ? last.id : null,
      batch: { id: item.id, name: item.name, sha256: item.sha256 },
    };
  }

  async family(
    auth: AuthContext,
    id: string,
  ): Promise<{
    items: {
      relationship: string;
      direction: 'parent' | 'child';
      detail: string;
      item: { id: string; kind: string; name: string; size: string; sha256: string };
    }[];
  }> {
    await this.requireItem(auth, id, (tx) =>
      tx.evidenceItem.findFirst({ where: { id, tenantId: auth.tenantId }, select: { id: true } }),
    );
    const rels = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.evidenceRelationship.findMany({
        where: { tenantId: auth.tenantId, OR: [{ parentId: id }, { childId: id }] },
        include: {
          parent: { select: { id: true, kind: true, name: true, size: true, sha256: true } },
          child: { select: { id: true, kind: true, name: true, size: true, sha256: true } },
        },
      }),
    );
    return {
      items: rels.map((rel) => {
        const other = rel.parentId === id ? rel.child : rel.parent;
        return {
          relationship: rel.kind,
          // Direction is relative to the requested item.
          direction: rel.parentId === id ? ('child' as const) : ('parent' as const),
          detail: rel.detail,
          item: {
            id: other.id,
            kind: other.kind,
            name: other.name,
            size: other.size.toString(),
            sha256: other.sha256,
          },
        };
      }),
    };
  }

  /** Chain-of-custody: acquisition facts + every audit event for this item. */
  async chain(
    auth: AuthContext,
    id: string,
  ): Promise<{
    acquisition: {
      acquiredAt: string;
      collectionId: string | null;
      provider: string | null;
      providerItemId: string;
      sourcePath: string;
      sha256: string;
      blobSha256: string | null;
      isApiExportDerivative: boolean;
    };
    events: {
      sequence: string;
      action: string;
      actorDisplay: string;
      occurredAt: string;
      summary: unknown;
      eventHash: string;
    }[];
  }> {
    const item = await this.requireItem(auth, id, (tx) =>
      tx.evidenceItem.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { blob: { select: { sha256: true } } },
      }),
    );
    const events = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: auth.tenantId, targetType: 'evidence_item', targetId: id },
        orderBy: { sequence: 'asc' },
      }),
    );
    return {
      acquisition: {
        acquiredAt: item.acquiredAt.toISOString(),
        collectionId: item.collectionId,
        provider: item.provider,
        providerItemId: item.providerItemId,
        sourcePath: item.sourcePath,
        sha256: item.sha256,
        blobSha256: item.blob?.sha256 ?? null,
        isApiExportDerivative: item.isApiExportDerivative,
      },
      events: events.map((event) => ({
        sequence: event.sequence.toString(),
        action: event.action,
        actorDisplay: event.actorDisplay,
        occurredAt: event.occurredAt.toISOString(),
        summary: event.summary,
        eventHash: event.eventHash,
      })),
    };
  }

  async preview(
    auth: AuthContext,
    id: string,
  ): Promise<{
    items: { kind: string; mimeType: string; pageCount: number; url: string }[];
    note: string;
  }> {
    const item = await this.requireItem(auth, id, (tx) =>
      tx.evidenceItem.findFirst({ where: { id, tenantId: auth.tenantId }, select: { id: true } }),
    );
    const previews = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.preview.findMany({
        where: { tenantId: auth.tenantId, evidenceItemId: item.id },
        orderBy: [{ kind: 'asc' }, { version: 'desc' }],
      }),
    );
    // Latest version per kind only.
    const seen = new Set<string>();
    const latest = previews.filter((p) => {
      if (seen.has(p.kind)) return false;
      seen.add(p.kind);
      return true;
    });
    const items = await Promise.all(
      latest.map(async (p) => ({
        kind: p.kind,
        mimeType: p.mimeType,
        pageCount: p.pageCount,
        url: await this.store.presignGet(auth.tenantId, p.objectKey, {
          ttlSeconds: this.config.CDFIR_S3_PRESIGN_TTL_SECONDS,
        }),
      })),
    );
    return { items, note: PREVIEW_SAFETY_NOTE };
  }

  /**
   * Presign the original native bytes. Infected items are refused with 423
   * unless an org_admin explicitly confirms the danger (both paths audited).
   */
  async native(
    auth: AuthContext,
    id: string,
    confirmDangerous: boolean,
    request: FastifyRequest,
  ): Promise<{ url: string; name: string; sha256: string; expiresInSeconds: number }> {
    const item = await this.requireItem(auth, id, (tx) =>
      tx.evidenceItem.findFirst({
        where: { id, tenantId: auth.tenantId },
        include: { blob: { select: { objectKey: true, sha256: true } } },
      }),
    );
    if (!item.blob) {
      throw new ConflictException('this item has no stored native content');
    }

    let overrideUsed = false;
    if (item.malwareStatus === MalwareStatus.infected) {
      const isOrgAdmin = auth.roles.includes(TenantRole.org_admin);
      if (!isOrgAdmin || !confirmDangerous) {
        throw new HttpException(
          'this item is flagged as malware; download is locked (org_admin may override with confirmDangerous=1)',
          423,
        );
      }
      overrideUsed = true;
    }

    const url = await this.store.presignGet(auth.tenantId, item.blob.objectKey, {
      ttlSeconds: this.config.CDFIR_S3_PRESIGN_TTL_SECONDS,
    });

    // Native access is ALWAYS audited — this is how exports of single items
    // are tracked in the chain of custody. Never log the presigned URL.
    await withTenantContext(this.prisma, auth.tenantId, async (tx) => {
      if (overrideUsed) {
        await this.audit.appendTx(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          actorDisplay: auth.actorDisplay,
          effectiveRoles: auth.roles,
          action: 'evidence.infected_download_override',
          targetType: 'evidence_item',
          targetId: item.id,
          summary: { sha256: item.blob?.sha256 ?? '' },
          request,
        });
      }
      await this.audit.appendTx(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorDisplay: auth.actorDisplay,
        effectiveRoles: auth.roles,
        action: 'evidence.native_downloaded',
        targetType: 'evidence_item',
        targetId: item.id,
        summary: { name: item.name, sha256: item.blob?.sha256 ?? '', size: item.size.toString() },
        request,
      });
    });

    return {
      url,
      name: item.name,
      sha256: item.blob.sha256,
      expiresInSeconds: this.config.CDFIR_S3_PRESIGN_TTL_SECONDS,
    };
  }
}
