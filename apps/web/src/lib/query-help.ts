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
