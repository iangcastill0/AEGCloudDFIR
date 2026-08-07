import { PrismaClient, Prisma } from '@prisma/client';

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantScopedTx = Prisma.TransactionClient;

/**
 * Create the runtime Prisma client. The runtime database role must NOT have
 * BYPASSRLS; row-level security policies compare tenant_id with
 * current_setting('app.tenant_id').
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    datasourceUrl: databaseUrl,
    log: [{ emit: 'event', level: 'error' }],
  });
}

/**
 * Run `fn` inside a transaction whose tenant context is pinned via
 * `SET LOCAL app.tenant_id`. Every tenant-owned table's RLS policy depends on
 * this setting, so queries outside this wrapper see zero tenant rows.
 *
 * SET LOCAL scopes the value to the transaction, so contexts can never leak
 * across pooled connections.
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: TenantScopedTx) => Promise<T>,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new TenantContextError(`tenant id is not a UUID`);
  }
  return prisma.$transaction(
    async (tx) => {
      // Parameterized set_config = SET LOCAL, immune to injection.
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    {
      isolationLevel: options?.isolationLevel,
      timeout: options?.timeout ?? 30_000,
    },
  );
}
