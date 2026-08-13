import { PrismaClient, Prisma } from '@prisma/client';

export type PlatformScopedTx = Prisma.TransactionClient;

/**
 * Run `fn` inside a transaction whose platform context is pinned via
 * `SET LOCAL app.platform = 'true'`.
 *
 * The RLS migration grants this context exactly three things: enumerate
 * `tenants`, INSERT `tenants` (the onboarding path), and SELECT `audit_events`
 * for operational verification. It deliberately receives NO policy on any
 * evidence-bearing table, so platform context can create a tenant but cannot
 * read a single byte of anyone's evidence. Do not add evidence-table policies
 * for `app.platform` — that separation is the reason a platform operator is not
 * also an evidence custodian.
 *
 * Like withTenantContext, SET LOCAL scopes the value to the transaction, so the
 * context can never leak across pooled connections.
 */
export async function withPlatformContext<T>(
  prisma: PrismaClient,
  fn: (tx: PlatformScopedTx) => Promise<T>,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
      return fn(tx);
    },
    {
      isolationLevel: options?.isolationLevel,
      timeout: options?.timeout ?? 30_000,
    },
  );
}
