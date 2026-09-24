/**
 * Reads migration SQL well enough to answer one question: can
 * `prisma migrate deploy` apply this file, or does it have to be run by hand?
 *
 * BACKGROUND, because this repo used to say the answer was "by hand".
 *
 * Prisma runs each migration file inside ONE transaction. PostgreSQL 11 and
 * earlier refused `ALTER TYPE ... ADD VALUE` inside any transaction block at
 * all, which is why Prisma's own generated migrations carry a comment about
 * "PostgreSQL versions 11 and earlier", and why ADR-011 recorded that enum
 * changes here get applied by hand on both databases.
 *
 * PostgreSQL 12 lifted that. Adding an enum value inside a transaction is now
 * allowed, with ONE condition: nothing in the same transaction may use the new
 * value. Both compose files and CI run `postgres:16-alpine`, and CI's
 * `migrations` job applies all of these migrations to an empty PostgreSQL 16 on
 * every push. So enum migrations do not need to be manual here — provided that
 * one condition holds.
 *
 * Which makes the condition worth enforcing rather than remembering. A migration
 * that adds an enum value and then uses it in the same file is the one shape
 * `prisma migrate deploy` genuinely cannot apply, and it would fail in the
 * middle of a deploy with `unsafe use of new value of enum type`. Checking it
 * here turns that into a red test on the Mac.
 *
 * Creating a brand-new enum and using it immediately is fine, and common — see
 * 20260922140000_self_serve_tenancy, which creates "BillingStatus" and adds a
 * column of that type. PostgreSQL allows it because the type did not exist
 * outside this transaction, so no other session can be holding a stale copy.
 */

export interface EnumValueAddition {
  /** The enum type, without its quotes. */
  type: string;
  /** The value being added, without its quotes. */
  value: string;
}

/**
 * `ALTER TYPE "X" ADD VALUE [IF NOT EXISTS] 'v'`, with or without a semicolon.
 * Global and case-insensitive; `lastIndex` is reset by every caller below.
 */
const ADD_VALUE =
  /ALTER\s+TYPE\s+"([^"]+)"\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']*)'\s*;?/gi;
const CREATE_ENUM = /CREATE\s+TYPE\s+"([^"]+)"\s+AS\s+ENUM/gi;

/**
 * Drops `-- line` comments and block comments.
 *
 * Every enum migration in this repo explains itself in a comment directly above
 * the statement, and those comments quote the value they are about. Scanning the
 * raw text would report each of them as a misuse, and a check that cries wolf on
 * every real file gets deleted within a week.
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Values this migration adds to an enum that already exists elsewhere. */
export function enumValuesAdded(sql: string): EnumValueAddition[] {
  const body = stripSqlComments(sql);
  const found: EnumValueAddition[] = [];
  ADD_VALUE.lastIndex = 0;
  for (let m = ADD_VALUE.exec(body); m !== null; m = ADD_VALUE.exec(body)) {
    // Both groups are non-optional in ADD_VALUE, so a match always fills them.
    found.push({ type: m[1]!, value: m[2]! });
  }
  return found;
}

/** Enum types this migration creates from nothing, which are exempt. */
export function enumTypesCreated(sql: string): string[] {
  const body = stripSqlComments(sql);
  const found: string[] = [];
  CREATE_ENUM.lastIndex = 0;
  for (let m = CREATE_ENUM.exec(body); m !== null; m = CREATE_ENUM.exec(body)) {
    found.push(m[1]!);
  }
  return found;
}

function quoteRegExp(literal: string): RegExp {
  return new RegExp(`'${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
}

/**
 * Enum values this migration adds AND then uses, which PostgreSQL will refuse.
 *
 * An empty array means `prisma migrate deploy` can apply the file. Anything in it
 * has to be split into two migrations: one that only adds the value, and a later
 * one that uses it.
 */
export function enumValuesUsedInSameMigration(sql: string): EnumValueAddition[] {
  const additions = enumValuesAdded(sql);
  if (additions.length === 0) return [];

  const created = new Set(enumTypesCreated(sql));
  // The ADD VALUE statements themselves quote the value; that is not a use of it.
  const rest = stripSqlComments(sql).replace(ADD_VALUE, ' ');

  return additions.filter(({ type, value }) => !created.has(type) && quoteRegExp(value).test(rest));
}
