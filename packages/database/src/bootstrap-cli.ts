#!/usr/bin/env node
/**
 * Operator CLI: create a tenant and grant its first administrator.
 *
 *   node dist/bootstrap-cli.js \
 *     --tenant-slug evestigate --tenant-name "Evestigate" \
 *     --email someone@example.com [--roles org_admin,auditor] [--platform-admin]
 *
 * Reads CDFIR_DATABASE_URL from the environment. Run it where that variable is
 * already set (e.g. `docker compose exec api`) so no credential is ever typed
 * on a command line, where it would land in shell history and the process list.
 *
 * Idempotent — see bootstrapOrgAdmin. Re-running after the target person signs
 * in for the first time is the intended workflow, not a workaround.
 */
import { TenantRole } from '@prisma/client';
import { createPrismaClient } from './client.js';
import { bootstrapOrgAdmin, BootstrapError, type BootstrapOrgAdminInput } from './bootstrap.js';

const VALID_ROLES = Object.values(TenantRole) as string[];

function usage(problem?: string): never {
  if (problem) process.stderr.write(`error: ${problem}\n\n`);
  process.stderr.write(
    `usage: bootstrap-cli --tenant-slug <slug> --email <address>\n` +
      `                     [--tenant-name <name>] [--roles <a,b>] [--platform-admin]\n\n` +
      `  --tenant-slug     lowercase [a-z0-9-], 2-63 chars; identifies the tenant\n` +
      `  --tenant-name     display name, used only when creating the tenant\n` +
      `  --email           must match the IdP 'email' claim (case-insensitive)\n` +
      `  --roles           comma-separated; default org_admin\n` +
      `                    one of: ${VALID_ROLES.join(', ')}\n` +
      `  --platform-admin  also set the deployment-operator flag (grants no\n` +
      `                    access to any tenant's evidence)\n`,
  );
  process.exit(problem ? 2 : 0);
}

function parseArgs(argv: string[]): BootstrapOrgAdminInput {
  const flags = new Map<string, string>();
  let platformAdmin = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') usage();
    if (arg === '--platform-admin') {
      platformAdmin = true;
      continue;
    }
    if (!arg.startsWith('--')) usage(`unexpected argument "${arg}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage(`${arg} requires a value`);
    flags.set(arg.slice(2), value);
    i += 1;
  }

  const known = new Set(['tenant-slug', 'tenant-name', 'email', 'roles']);
  for (const key of flags.keys()) {
    if (!known.has(key)) usage(`unknown flag --${key}`);
  }

  const tenantSlug = flags.get('tenant-slug');
  const email = flags.get('email');
  if (!tenantSlug) usage('--tenant-slug is required');
  if (!email) usage('--email is required');

  let roles: TenantRole[] | undefined;
  const rolesRaw = flags.get('roles');
  if (rolesRaw !== undefined) {
    roles = [];
    for (const part of rolesRaw.split(',')) {
      const name = part.trim();
      if (name.length === 0) continue;
      if (!VALID_ROLES.includes(name)) usage(`"${name}" is not a role`);
      roles.push(name as TenantRole);
    }
    if (roles.length === 0) usage('--roles was empty');
  }

  return {
    tenantSlug,
    tenantName: flags.get('tenant-name') ?? tenantSlug,
    email,
    ...(roles ? { roles } : {}),
    platformAdmin,
  };
}

async function main(): Promise<number> {
  const input = parseArgs(process.argv.slice(2));
  const url = process.env['CDFIR_DATABASE_URL'];
  if (!url || url.length === 0) {
    process.stderr.write('error: CDFIR_DATABASE_URL is not set\n');
    return 2;
  }

  const prisma = createPrismaClient(url);
  try {
    const result = await bootstrapOrgAdmin(prisma, input);
    if (result.status === 'awaiting_first_login') {
      process.stdout.write(
        `tenant ${result.tenantSlug} (${result.tenantId}) ` +
          `${result.tenantCreated ? 'created' : 'already existed'}\n\n` +
          `No user account carries ${result.email} yet, so no admin was granted.\n` +
          `The app identifies users by the IdP subject, which for Authentik is a\n` +
          `salted hash that cannot be computed here — only a real sign-in creates\n` +
          `the record.\n\n` +
          `Next:\n` +
          `  1. Confirm an Authentik account exists with this exact email.\n` +
          `  2. Have that person sign in once. Expect "no active membership" —\n` +
          `     that is the account being created, not a failure.\n` +
          `  3. Re-run this exact command to grant the roles.\n`,
      );
      return 3;
    }

    const lines = [
      `tenant       ${result.tenantSlug} (${result.tenantId})${result.tenantCreated ? ' [created]' : ''}`,
      `user         ${result.email} (${result.userId})`,
      `membership   ${result.membershipCreated ? 'created' : 'already existed'}`,
      `roles added  ${result.rolesAdded.length > 0 ? result.rolesAdded.join(', ') : '(none — already granted)'}`,
      `roles now    ${result.rolesEffective.join(', ')}`,
    ];
    if (result.platformAdminChanged) lines.push('platform     isPlatformAdmin set');
    lines.push('', 'Recorded in the tenant audit chain as tenant.bootstrap_admin.');
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } catch (err) {
    if (err instanceof BootstrapError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Never interpolate the connection URL into output: it carries the password.
    process.stderr.write(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
