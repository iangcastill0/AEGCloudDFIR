import { createHash } from 'node:crypto';
import type { TenantScopedTx } from './client.js';

/** Hash of the empty chain head. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic canonical JSON (RFC 8785 style for our value domain):
 * object keys sorted lexicographically, no insignificant whitespace,
 * BigInt as decimal string, Date as ISO-8601 UTC string, undefined dropped.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('non-finite number in audit payload');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object':
      break;
    default:
      throw new TypeError(`unsupported type in audit payload: ${typeof value}`);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => serialize(v ?? null)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`);
  return `{${entries.join(',')}}`;
}

export interface AuditEventInput {
  tenantId: string;
  actorUserId?: string;
  actorDisplay?: string;
  effectiveRoles?: string[];
  action: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  summary?: Record<string, unknown>;
}

interface HashableEvent {
  tenantId: string;
  sequence: bigint;
  actorUserId: string;
  actorDisplay: string;
  effectiveRoles: string[];
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  ipAddress: string;
  userAgent: string;
  summary: Record<string, unknown>;
  occurredAt: Date;
}

/** event_hash = SHA-256(prev_event_hash || canonical_json(event_without_hash)) */
export function computeEventHash(prevEventHash: string, event: HashableEvent): string {
  return createHash('sha256')
    .update(prevEventHash, 'utf8')
    .update(canonicalJson(event), 'utf8')
    .digest('hex');
}

/**
 * Append an audit event to the tenant's hash chain. Must be called inside a
 * tenant-scoped transaction so the event commits or rolls back atomically
 * with the action it records. A per-tenant advisory lock serializes the
 * chain head; the audit table itself is append-only (trigger + revoked
 * UPDATE/DELETE, see migrations).
 */
export async function appendAuditEvent(
  tx: TenantScopedTx,
  input: AuditEventInput,
): Promise<{ id: string; sequence: bigint; eventHash: string }> {
  // Serialize per-tenant chain growth for the rest of this transaction.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('audit:' || ${input.tenantId}, 0))`;

  const head = await tx.auditEvent.findFirst({
    where: { tenantId: input.tenantId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true, eventHash: true },
  });

  const sequence = (head?.sequence ?? 0n) + 1n;
  const prevEventHash = head?.eventHash ?? GENESIS_HASH;
  const occurredAt = new Date();

  const hashable: HashableEvent = {
    tenantId: input.tenantId,
    sequence,
    actorUserId: input.actorUserId ?? '',
    actorDisplay: input.actorDisplay ?? '',
    effectiveRoles: input.effectiveRoles ?? [],
    action: input.action,
    targetType: input.targetType ?? '',
    targetId: input.targetId ?? '',
    requestId: input.requestId ?? '',
    ipAddress: input.ipAddress ?? '',
    userAgent: input.userAgent ?? '',
    summary: input.summary ?? {},
    occurredAt,
  };

  const eventHash = computeEventHash(prevEventHash, hashable);

  const created = await tx.auditEvent.create({
    data: { ...hashable, summary: hashable.summary as object, prevEventHash, eventHash },
    select: { id: true },
  });
  return { id: created.id, sequence, eventHash };
}

export interface AuditChainVerification {
  valid: boolean;
  checkedCount: number;
  firstInvalidSequence: bigint | null;
  reason: string;
}

/**
 * Recompute the full chain for a tenant and report the first divergence.
 * Runnable offline against any database or dump (used by scripts/audit-verify).
 */
export async function verifyAuditChain(
  tx: TenantScopedTx,
  tenantId: string,
  pageSize = 1000,
): Promise<AuditChainVerification> {
  let prevHash = GENESIS_HASH;
  let expectedSequence = 1n;
  let checkedCount = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await tx.auditEvent.findMany({
      where: { tenantId },
      orderBy: { sequence: 'asc' },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;

    for (const event of page) {
      if (event.sequence !== expectedSequence) {
        return {
          valid: false,
          checkedCount,
          firstInvalidSequence: event.sequence,
          reason: `sequence gap: expected ${expectedSequence}, found ${event.sequence}`,
        };
      }
      if (event.prevEventHash !== prevHash) {
        return {
          valid: false,
          checkedCount,
          firstInvalidSequence: event.sequence,
          reason: 'prev_event_hash does not match prior event hash',
        };
      }
      const recomputed = computeEventHash(prevHash, {
        tenantId: event.tenantId,
        sequence: event.sequence,
        actorUserId: event.actorUserId,
        actorDisplay: event.actorDisplay,
        effectiveRoles: event.effectiveRoles,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        requestId: event.requestId,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        summary: (event.summary ?? {}) as Record<string, unknown>,
        occurredAt: event.occurredAt,
      });
      if (recomputed !== event.eventHash) {
        return {
          valid: false,
          checkedCount,
          firstInvalidSequence: event.sequence,
          reason: 'event content does not match stored hash',
        };
      }
      prevHash = event.eventHash;
      expectedSequence += 1n;
      checkedCount += 1;
    }
    const last = page[page.length - 1];
    if (!last) break;
    cursor = last.id;
    if (page.length < pageSize) break;
  }

  return { valid: true, checkedCount, firstInvalidSequence: null, reason: '' };
}
