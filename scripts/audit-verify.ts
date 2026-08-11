#!/usr/bin/env tsx
/**
 * Audit-chain verification command (ADR-010).
 *
 * Recomputes every tenant's audit hash chain from the database and reports
 * the first divergence, if any. Runnable against a live database or a
 * restored dump; requires only read access.
 *
 *   pnpm audit:verify                # verify all tenants
 *   pnpm audit:verify -- --tenant <uuid>
 */
import { loadConfig } from '@evidencevault/config';
import { createPrismaClient, verifyAuditChain, withTenantContext } from '@evidencevault/database';

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = createPrismaClient(config.EV_DATABASE_URL);
  const tenantArgIdx = process.argv.indexOf('--tenant');
  const onlyTenant = tenantArgIdx >= 0 ? process.argv[tenantArgIdx + 1] : undefined;

  try {
    const tenants = onlyTenant
      ? [{ id: onlyTenant, name: '(specified)' }]
      : await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
          return tx.tenant.findMany({ select: { id: true, name: true } });
        });

    if (tenants.length === 0) {
      console.log('no tenants found — nothing to verify');
      return;
    }

    let allValid = true;
    for (const tenant of tenants) {
      const result = await withTenantContext(prisma, tenant.id, (tx) =>
        verifyAuditChain(tx, tenant.id),
      );
      if (result.valid) {
        console.log(
          `✔ tenant ${tenant.id} (${tenant.name}): ${result.checkedCount} events, chain intact`,
        );
      } else {
        allValid = false;
        console.error(
          `✘ tenant ${tenant.id} (${tenant.name}): INVALID at sequence ${result.firstInvalidSequence} — ${result.reason} (${result.checkedCount} events verified before failure)`,
        );
      }
    }
    process.exit(allValid ? 0 : 2);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('audit-verify failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
