/**
 * Runs against the REAL migration files, not fixtures.
 *
 * The question this answers is whether `scripts/migrate.sh` can apply what is in
 * prisma/migrations, or whether an operator has to. Asking fixtures that would
 * be a test of the fixtures.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  enumTypesCreated,
  enumValuesAdded,
  enumValuesUsedInSameMigration,
  stripSqlComments,
} from './migration-sql.js';

const MIGRATIONS = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

const files = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8') }));

describe('every migration in this repo can be applied by prisma migrate deploy', () => {
  it('found the migrations, so the checks below are not looking at nothing', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('several of them really do add enum values', () => {
    // Without this, the check below passes for the boring reason and would keep
    // passing after someone broke the parser.
    const withEnumAdditions = files.filter((f) => enumValuesAdded(f.sql).length > 0);
    expect(withEnumAdditions.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => f.name))('%s never uses an enum value it just added', (name) => {
    // PostgreSQL 12+ allows ALTER TYPE ... ADD VALUE inside a transaction, which
    // is how prisma runs each migration — but only while nothing in the same
    // transaction uses the value. Break that and the deploy dies halfway with
    // "unsafe use of new value of enum type".
    const sql = files.find((f) => f.name === name)?.sql ?? '';
    expect(enumValuesUsedInSameMigration(sql)).toEqual([]);
  });
});

describe('enumValuesUsedInSameMigration', () => {
  it('catches a value added and then used', () => {
    const bad = `
      ALTER TYPE "ExportKind" ADD VALUE IF NOT EXISTS 'pst';
      UPDATE "exports" SET "kind" = 'pst' WHERE "legacy" = true;
    `;
    expect(enumValuesUsedInSameMigration(bad)).toEqual([{ type: 'ExportKind', value: 'pst' }]);
  });

  it('allows a value added and left alone, which is what every real one does', () => {
    const good = `ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'slack';`;
    expect(enumValuesUsedInSameMigration(good)).toEqual([]);
  });

  it('allows a brand-new enum used straight away', () => {
    // PostgreSQL permits this: the type did not exist outside this transaction,
    // so no other session can hold a stale copy of it. 20260922140000 does it.
    const good = `
      CREATE TYPE "BillingStatus" AS ENUM ('none', 'trial', 'active');
      ALTER TYPE "BillingStatus" ADD VALUE IF NOT EXISTS 'past_due';
      ALTER TABLE "tenants" ADD COLUMN "billingStatus" "BillingStatus" NOT NULL DEFAULT 'past_due';
    `;
    expect(enumValuesUsedInSameMigration(good)).toEqual([]);
  });

  it('does not count a comment as a use', () => {
    // Every enum migration here explains itself right above the statement, and
    // the explanation quotes the value. A checker that reads comments would fire
    // on all of them, and then get deleted.
    const good = `
      -- 'chat' is a source of its own rather than a flavour of 'email'.
      ALTER TYPE "CollectionSource" ADD VALUE IF NOT EXISTS 'chat';
    `;
    expect(enumValuesUsedInSameMigration(good)).toEqual([]);
  });

  it('reads ALTER TYPE without IF NOT EXISTS, as the oldest migrations are written', () => {
    const sql = `ALTER TYPE "EvidenceKind" ADD VALUE 'audit_record';`;
    expect(enumValuesAdded(sql)).toEqual([{ type: 'EvidenceKind', value: 'audit_record' }]);
  });

  it('sees every addition when one file adds several', () => {
    const sql = `
      ALTER TYPE "EvidenceKind" ADD VALUE IF NOT EXISTS 'chat_message';
      ALTER TYPE "EvidenceKind" ADD VALUE IF NOT EXISTS 'chat_conversation';
    `;
    expect(enumValuesAdded(sql).map((a) => a.value)).toEqual(['chat_message', 'chat_conversation']);
  });
});

describe('stripSqlComments', () => {
  it('removes line comments but keeps the statement', () => {
    expect(stripSqlComments("-- why\nSELECT 'a';")).toContain("SELECT 'a';");
    expect(stripSqlComments("-- why\nSELECT 'a';")).not.toContain('why');
  });

  it('removes block comments', () => {
    expect(stripSqlComments("/* why\n   more */ SELECT 'a';")).not.toContain('more');
  });
});

describe('enumTypesCreated', () => {
  it('names the enums a migration creates', () => {
    expect(enumTypesCreated(`CREATE TYPE "BillingStatus" AS ENUM ('none');`)).toEqual([
      'BillingStatus',
    ]);
  });

  it('does not confuse a plain table with an enum', () => {
    expect(enumTypesCreated(`CREATE TABLE "tenants" ("id" UUID);`)).toEqual([]);
  });
});
