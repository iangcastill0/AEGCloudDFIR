import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import {
  TenantRole,
  verifyAuditChain,
  withTenantContext,
  type AuditEvent,
  type PrismaClient,
} from '@aeg-clouddfir/database';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import { PRISMA } from '../common/tokens.js';
import { parseCursorQuery } from '../common/pagination.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { TenantGuard } from '../auth/guards/tenant.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequireRoles } from '../auth/guards/require-roles.decorator.js';
import { AuditService } from './audit.service.js';

interface AuditEventDto {
  id: string;
  sequence: string;
  actorUserId: string;
  actorDisplay: string;
  effectiveRoles: string[];
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  ipAddress: string;
  userAgent: string;
  summary: unknown;
  occurredAt: string;
  prevEventHash: string;
  eventHash: string;
}

function toDto(event: AuditEvent): AuditEventDto {
  return {
    id: event.id,
    sequence: event.sequence.toString(),
    actorUserId: event.actorUserId,
    actorDisplay: event.actorDisplay,
    effectiveRoles: event.effectiveRoles,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    requestId: event.requestId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    summary: event.summary,
    occurredAt: event.occurredAt.toISOString(),
    prevEventHash: event.prevEventHash,
    eventHash: event.eventHash,
  };
}

@Controller('api/v1/audit')
@UseGuards(SessionGuard, TenantGuard, RolesGuard)
@RequireRoles(TenantRole.org_admin, TenantRole.auditor)
export class AuditController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ): Promise<{ items: AuditEventDto[]; nextCursor: string | null }> {
    const auth = request.cdfirAuth;
    const { limit, cursor } = parseCursorQuery(query);
    if (!auth) return { items: [], nextCursor: null };

    const rows = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: auth.tenantId },
        orderBy: { sequence: 'desc' },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDto),
      nextCursor: rows.length > limit && last ? last.id : null,
    };
  }

  @Get('verify')
  async verify(@Req() request: FastifyRequest): Promise<{
    valid: boolean;
    checkedCount: number;
    firstInvalidSequence: string | null;
    reason: string;
  }> {
    const auth = request.cdfirAuth;
    if (!auth) return { valid: false, checkedCount: 0, firstInvalidSequence: null, reason: '' };

    const report = await withTenantContext(this.prisma, auth.tenantId, (tx) =>
      verifyAuditChain(tx, auth.tenantId),
    );

    await this.audit.append({
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorDisplay: auth.actorDisplay,
      effectiveRoles: auth.roles,
      action: 'audit.chain_verified',
      summary: { valid: report.valid, checkedCount: report.checkedCount },
      request,
    });

    return {
      valid: report.valid,
      checkedCount: report.checkedCount,
      firstInvalidSequence:
        report.firstInvalidSequence === null ? null : report.firstInvalidSequence.toString(),
      reason: report.reason,
    };
  }
}
