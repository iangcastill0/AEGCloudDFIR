import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../prisma/migrations/20260924180000_runtime_table_grants/migration.sql',
  import.meta.url,
);

describe('runtime table grants repair migration', () => {
  it('grants CRUD to cdfir for every affected tenant table', () => {
    const sql = readFileSync(migrationUrl, 'utf8');
    for (const table of [
      'export_parts',
      'tenant_invites',
      'forensic_imports',
      'import_artifacts',
      'import_cases',
    ]) {
      expect(sql).toContain(`"${table}"`);
    }
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE');
    expect(sql).toContain('TO cdfir');
  });
});
