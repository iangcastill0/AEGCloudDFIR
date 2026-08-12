#!/usr/bin/env tsx
/**
 * DEMO SEED MODE — clearly labeled, local evaluation only.
 *
 * Requires CDFIR_DEMO_MODE=true (refused otherwise, and loadConfig refuses that
 * in production). Seeds:
 *   - tenant "Demo Matter Workspace" (slug demo-a) with every existing user
 *     as org_admin/case_manager/production_manager/reviewer
 *   - tenant "Adverse Party Workspace" (slug demo-b) with NO members —
 *     exists purely so cross-tenant access attempts have a real target
 *   - connected Microsoft and Google delegated connector accounts whose
 *     encrypted refresh tokens are canned values accepted only by the local
 *     fake provider server (scripts/demo-provider.ts)
 *   - one custodian per connector matching the sanitized fixtures
 *
 * Flow: log in once through Authentik (creates your user), then run this,
 * then re-select the tenant in the UI and start a collection.
 */
import { loadConfig } from '@aeg-clouddfir/config';
import {
  createPrismaClient,
  withTenantContext,
  encryptSecret,
  LocalAesKeyEncryptionProvider,
  appendAuditEvent,
} from '@aeg-clouddfir/database';

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.CDFIR_DEMO_MODE) {
    console.error('demo-seed refused: CDFIR_DEMO_MODE is not true');
    process.exit(1);
  }
  const prisma = createPrismaClient(config.CDFIR_DATABASE_URL);
  const kek = new LocalAesKeyEncryptionProvider(
    { [config.CDFIR_KEK_ACTIVE_KEY_ID]: config.CDFIR_KEK_LOCAL_MASTER_KEY },
    config.CDFIR_KEK_ACTIVE_KEY_ID,
  );

  try {
    const users = await prisma.user.findMany({ select: { id: true, email: true } });
    if (users.length === 0) {
      console.error(
        'no users exist yet — log in once via the web app (Authentik) and re-run demo-seed',
      );
      process.exit(1);
    }

    const [tenantA, tenantB] = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
      const a = await tx.tenant.upsert({
        where: { slug: 'demo-a' },
        create: { name: 'Demo Matter Workspace (DEMO SEED)', slug: 'demo-a' },
        update: {},
      });
      const b = await tx.tenant.upsert({
        where: { slug: 'demo-b' },
        create: { name: 'Adverse Party Workspace (DEMO SEED)', slug: 'demo-b' },
        update: {},
      });
      return [a, b] as const;
    });

    await withTenantContext(prisma, tenantA.id, async (tx) => {
      for (const user of users) {
        const membership = await tx.membership.upsert({
          where: { tenantId_userId: { tenantId: tenantA.id, userId: user.id } },
          create: { tenantId: tenantA.id, userId: user.id },
          update: {},
        });
        for (const role of [
          'org_admin',
          'case_manager',
          'production_manager',
          'reviewer',
        ] as const) {
          await tx.roleAssignment.upsert({
            where: { membershipId_role: { membershipId: membership.id, role } },
            create: { tenantId: tenantA.id, membershipId: membership.id, role },
            update: {},
          });
        }
      }

      for (const seed of [
        {
          provider: 'microsoft' as const,
          label: 'Demo Microsoft account (fake provider)',
          identity: 'avery.chen@example.com',
        },
        {
          provider: 'google' as const,
          label: 'Demo Google account (fake provider)',
          identity: 'jordan.lee@example.com',
        },
      ]) {
        const existing = await tx.connectorAccount.findFirst({
          where: { provider: seed.provider, label: seed.label },
        });
        if (existing) continue;
        const account = await tx.connectorAccount.create({
          data: {
            tenantId: tenantA.id,
            provider: seed.provider,
            mode: 'delegated',
            label: seed.label,
            externalIdentity: seed.identity,
            status: 'connected',
            statusDetail: 'demo seed — fake provider server',
          },
        });
        const enc = await encryptSecret(
          kek,
          tenantA.id,
          `connector:${account.id}`,
          Buffer.from('demo-refresh-token'),
        );
        await tx.connectorSecret.create({
          data: {
            tenantId: tenantA.id,
            connectorAccountId: account.id,
            kind: 'oauth_refresh_token',
            kekKeyId: enc.kekKeyId,
            wrappedDek: new Uint8Array(enc.wrappedDek),
            dekIv: new Uint8Array(enc.dekIv),
            dekTag: new Uint8Array(enc.dekTag),
            ciphertext: new Uint8Array(enc.ciphertext),
            cipherIv: new Uint8Array(enc.cipherIv),
            cipherTag: new Uint8Array(enc.cipherTag),
          },
        });
        await tx.custodian.create({
          data: {
            tenantId: tenantA.id,
            connectorAccountId: account.id,
            externalId: 'me',
            email: seed.identity,
            displayName: seed.identity.split('@')[0] ?? seed.identity,
          },
        });
        await appendAuditEvent(tx, {
          tenantId: tenantA.id,
          actorDisplay: 'demo-seed script',
          action: 'connector.demo_seeded',
          targetType: 'connector_account',
          targetId: account.id,
          summary: { provider: seed.provider, mode: 'delegated', demo: true },
        });
      }
    });

    console.log('demo seed complete:');
    console.log(`  tenant A (yours): ${tenantA.name} [${tenantA.id}]`);
    console.log(`  tenant B (no members, for isolation tests): ${tenantB.name} [${tenantB.id}]`);
    console.log('next steps:');
    console.log('  1. pnpm tsx scripts/demo-provider.ts   (keep running)');
    console.log('  2. ensure .env points provider base URLs at the fake server (it prints them)');
    console.log('  3. restart api+worker, select the demo tenant, start a collection');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('demo-seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
