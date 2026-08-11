/**
 * Row-level-security integration tests — the cross-tenant negative tests the
 * build contract requires, run against a real PostgreSQL with migrations
 * applied (compose stack) under the NON-BYPASSRLS runtime role.
 *
 * Skipped unless EV_IT_DATABASE_URL is set (CI/compose provide it):
 *   EV_IT_DATABASE_URL=postgresql://evidencevault:changeme-local-only@localhost:5432/evidencevault
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaClient, withTenantContext } from './client.js';
import { appendAuditEvent, verifyAuditChain } from './audit.js';

const url = process.env.EV_IT_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('PostgreSQL RLS tenant isolation (integration)', () => {
  let prisma: PrismaClient;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    prisma = createPrismaClient(url!);
    tenantA = randomUUID();
    tenantB = randomUUID();
    // Tenants are created under platform context (as the onboarding path does).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
      await tx.tenant.createMany({
        data: [
          { id: tenantA, name: 'IT Tenant A', slug: `it-a-${tenantA.slice(0, 8)}` },
          { id: tenantB, name: 'IT Tenant B', slug: `it-b-${tenantB.slice(0, 8)}` },
        ],
      });
    });
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('a session without tenant context sees zero tenant rows (fail closed)', async () => {
    const tenants = await prisma.tenant.findMany();
    expect(tenants).toHaveLength(0);
    const blobs = await prisma.evidenceBlob.findMany();
    expect(blobs).toHaveLength(0);
  });

  it('tenant context exposes only that tenant', async () => {
    const sha = 'a'.repeat(64);
    await withTenantContext(prisma, tenantA, async (tx) => {
      await tx.evidenceBlob.create({
        data: {
          tenantId: tenantA,
          sha256: sha,
          size: 42n,
          objectKey: `tenants/${tenantA}/originals/sha256/aa/${sha}`,
        },
      });
    });

    const seenFromA = await withTenantContext(prisma, tenantA, (tx) => tx.evidenceBlob.findMany());
    expect(seenFromA).toHaveLength(1);

    const seenFromB = await withTenantContext(prisma, tenantB, (tx) => tx.evidenceBlob.findMany());
    expect(seenFromB).toHaveLength(0);

    // Direct lookup by primary key from the wrong tenant also yields nothing.
    const blobId = seenFromA[0]!.id;
    const crossRead = await withTenantContext(prisma, tenantB, (tx) =>
      tx.evidenceBlob.findUnique({ where: { id: blobId } }),
    );
    expect(crossRead).toBeNull();
  });

  it('WITH CHECK blocks inserting rows for a foreign tenant', async () => {
    const sha = 'b'.repeat(64);
    await expect(
      withTenantContext(prisma, tenantB, (tx) =>
        tx.evidenceBlob.create({
          data: {
            tenantId: tenantA, // mismatched on purpose
            sha256: sha,
            size: 1n,
            objectKey: `tenants/${tenantA}/originals/sha256/bb/${sha}`,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('cross-tenant UPDATE/DELETE affect zero rows', async () => {
    const updated = await withTenantContext(prisma, tenantB, (tx) =>
      tx.evidenceBlob.updateMany({ data: { providerChecksums: {} }, where: {} }),
    );
    expect(updated.count).toBe(0);
    const deleted = await withTenantContext(prisma, tenantB, (tx) =>
      tx.evidenceBlob.deleteMany({}),
    );
    expect(deleted.count).toBe(0);
  });

  it('audit chain appends per tenant and verifies; tampering is impossible in place', async () => {
    for (let i = 0; i < 3; i++) {
      await withTenantContext(prisma, tenantA, (tx) =>
        appendAuditEvent(tx, {
          tenantId: tenantA,
          action: `it.test.${i}`,
          actorDisplay: 'integration-test',
        }),
      );
    }
    const result = await withTenantContext(prisma, tenantA, (tx) =>
      verifyAuditChain(tx, tenantA),
    );
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBeGreaterThanOrEqual(3);

    // Append-only trigger: UPDATE and DELETE both raise.
    await expect(
      withTenantContext(prisma, tenantA, (tx) =>
        tx.$executeRaw`UPDATE audit_events SET action = 'forged' WHERE "tenantId" = ${tenantA}::uuid`,
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      withTenantContext(prisma, tenantA, (tx) =>
        tx.$executeRaw`DELETE FROM audit_events WHERE "tenantId" = ${tenantA}::uuid`,
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it('tenant B audit chain is independent of tenant A', async () => {
    await withTenantContext(prisma, tenantB, (tx) =>
      appendAuditEvent(tx, { tenantId: tenantB, action: 'it.b.only' }),
    );
    const b = await withTenantContext(prisma, tenantB, (tx) => verifyAuditChain(tx, tenantB));
    expect(b.valid).toBe(true);
  });

  it('outbox rows are invisible without worker context and visible with it', async () => {
    await withTenantContext(prisma, tenantA, (tx) =>
      tx.outboxEvent.create({
        data: {
          tenantId: tenantA,
          topic: 'collection.discover',
          dedupKey: `it:${randomUUID()}`,
          payload: {},
        },
      }),
    );
    const invisible = await prisma.outboxEvent.findMany();
    expect(invisible).toHaveLength(0);

    const visible = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.worker', 'true', true)`;
      return tx.outboxEvent.findMany({ where: { tenantId: tenantA } });
    });
    expect(visible.length).toBeGreaterThanOrEqual(1);
  });

  it('evidence blob content identity is immutable (trigger)', async () => {
    const blob = await withTenantContext(prisma, tenantA, (tx) => tx.evidenceBlob.findFirst());
    expect(blob).not.toBeNull();
    await expect(
      withTenantContext(prisma, tenantA, (tx) =>
        tx.evidenceBlob.update({
          where: { id: blob!.id },
          data: { sha256: 'c'.repeat(64) },
        }),
      ),
    ).rejects.toThrow(/immutable/i);
  });
});
