import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  appendAuditEvent,
  withTenantContext,
  type PrismaClient,
  type TenantScopedTx,
} from '@aeg-clouddfir/database';
import type { FastifyRequest } from 'fastify';
import '../common/http.js';
import { PRISMA } from '../common/tokens.js';

export interface AuditAppendInput {
  tenantId: string;
  actorUserId?: string;
  actorDisplay?: string;
  effectiveRoles?: string[];
  action: string;
  targetType?: string;
  targetId?: string;
  summary?: Record<string, unknown>;
  /** Source request; supplies requestId, ip (trustProxy-aware), user agent. */
  request?: FastifyRequest;
}

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Append a hash-chained audit event inside the tenant's RLS context. */
  async append(input: AuditAppendInput): Promise<{ id: string; sequence: bigint }> {
    return withTenantContext(this.prisma, input.tenantId, (tx) => this.appendTx(tx, input));
  }

  /**
   * Append within an ALREADY OPEN tenant-scoped transaction so the audit
   * event commits or rolls back atomically with the mutation it records.
   */
  async appendTx(
    tx: TenantScopedTx,
    input: AuditAppendInput,
  ): Promise<{ id: string; sequence: bigint }> {
    const req = input.request;
    const headerRequestId = req?.headers['x-request-id'];
    const requestId =
      req?.cdfirRequestId ??
      (typeof headerRequestId === 'string' ? headerRequestId : undefined) ??
      randomUUID();
    const userAgentHeader = req?.headers['user-agent'];

    return appendAuditEvent(tx, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorDisplay: input.actorDisplay,
      effectiveRoles: input.effectiveRoles,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      requestId,
      ipAddress: req?.ip ?? '',
      userAgent: typeof userAgentHeader === 'string' ? userAgentHeader : '',
      summary: input.summary,
    });
  }
}
