/**
 * Search query-language help content shown in the review workspace popover.
 * checkQueryExample is a lightweight sanity check (used by tests and to
 * guard the examples list): non-empty, balanced quotes and parentheses.
 */
export interface QueryExample {
  query: string;
  description: string;
}

export const QUERY_EXAMPLES: QueryExample[] = [
  { query: 'from:alice@example.com', description: 'Messages sent by a specific address' },
  {
    query: 'to:bob@example.com AND subject:"quarterly report"',
    description: 'Recipient plus exact subject phrase',
  },
  {
    query: 'bcc:carol@example.com',
    description: 'Messages where a BCC header/API field named this address',
  },
  { query: '(invoice OR receipt) AND NOT draft', description: 'Boolean grouping with exclusion' },
  {
    query: 'filetype:xlsx AND custodian:dana@example.com',
    description: 'Spreadsheets from one custodian',
  },
  {
    query: 'date:[2023-01-01 TO 2023-06-30] AND "wire transfer"',
    description: 'Date-bounded exact phrase',
  },
  {
    query: 'path:"/Shared drives/Finance" AND has:attachment',
    description: 'Drive location plus attachment presence',
  },
  {
    query: 'operation:MailItemsAccessed AND actor:alice@example.com',
    description: 'Audit events for one operation by one actor',
  },
  {
    query: 'auditsystem:google_reports AND workload:login',
    description: 'Google Reports sign-in audit batches',
  },
  {
    query: 'auditsystem:o365_management_activity AND workload:SharePoint',
    description: 'Office 365 SharePoint audit batches',
  },
];

/** Returns a list of problems with a query example (empty list = ok). */
export function checkQueryExample(query: string): string[] {
  const problems: string[] = [];
  if (query.trim().length === 0) problems.push('empty query');

  let quotes = 0;
  let depth = 0;
  for (const ch of query) {
    if (ch === '"') quotes += 1;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) problems.push('unbalanced closing parenthesis');
    }
  }
  if (quotes % 2 !== 0) problems.push('unbalanced quotes');
  if (depth > 0) problems.push('unclosed parenthesis');
  return problems;
}

/**
 * Examples for the advanced language (`parameter OPERATOR value`).
 *
 * Same query model as the simple language, different spelling — so these are
 * written to mirror the simple examples where possible, which is the quickest
 * way to see how one maps onto the other.
 */
export const ADVANCED_QUERY_EXAMPLES: QueryExample[] = [
  {
    query: 'from.address IS alice@example.com',
    description: 'Messages sent by a specific address',
  },
  {
    query: 'to.address IS bob@example.com AND subject CONTAINS "quarterly report"',
    description: 'Recipient plus exact subject phrase',
  },
  {
    query: 'tags IS ANY OF (Hot, Privileged, "For Review")',
    description: 'Any of several tags, without writing three conditions',
  },
  {
    query: 'body CONTAINS ANY OF ("wire transfer", "bank details")',
    description: 'Any of several phrases in the document body',
  },
  {
    query: 'body CONTAINS "wire transfer"~3',
    description: 'Words up to 3 positions apart (slop)',
  },
  {
    query: 'body DOES NOT CONTAIN draft AND date > 2026-01-01',
    description: 'Exclude a term, and bound by date',
  },
  { query: 'name.ext IS pdf AND size >= 1000000', description: 'PDFs of at least 1 MB' },
  { query: 'bates DOES NOT EXIST', description: 'Items with no Bates number yet' },
  {
    query: 'NOT (tags IS Confidential OR tags IS Privileged)',
    description: 'Everything outside two tags',
  },
];

/** Human labels for the language selector. */
export const QUERY_SYNTAX_OPTIONS = [
  { value: 'simple', label: 'Simple (field:value)' },
  { value: 'advanced', label: 'Advanced (CONTAINS / IS)' },
] as const;
