import { describe, expect, it, vi } from 'vitest';
import { BigQueryGmailConnector } from './bigquery-gmail.js';
import { StaticTokenProvider } from '../oauth.js';

const TOKEN = 'fake-bq-token-do-not-log';

/**
 * These tests use a mocked fetch — the connector is NOT verified against a real
 * BigQuery export (validated on staging per the connector's header note). They
 * pin the request shape and the schema-driven row decoding.
 */
function bqResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SAMPLE = {
  jobReference: { jobId: 'job-1', location: 'US' },
  jobComplete: true,
  totalRows: '2',
  schema: {
    fields: [
      { name: 'mail_event_type' },
      { name: 'actor_email' },
      { name: 'message_id' },
      { name: 'subject' },
      { name: 'client_type' },
      { name: 'ip_address' },
      { name: 'event_time' },
    ],
  },
  rows: [
    {
      f: [
        { v: '31' },
        { v: 'avery.chen@example.com' },
        { v: '<q3@mail.example.com>' },
        { v: 'Q3 vendor contract' },
        { v: 'WEB' },
        { v: '203.0.113.7' },
        { v: '2026-07-01T12:00:00Z' },
      ],
    },
    {
      f: [
        { v: '7' },
        { v: 'jordan.lee@example.com' },
        { v: '<dep@mail.example.com>' },
        { v: 'Deposition prep' },
        { v: 'IOS' },
        { v: '203.0.113.9' },
        { v: '2026-07-01T12:05:00Z' },
      ],
    },
  ],
};

function connector(fetchImpl: ReturnType<typeof vi.fn>) {
  return new BigQueryGmailConnector({
    tokenProvider: new StaticTokenProvider(TOKEN),
    projectId: 'proj-x',
    dataset: 'workspace_logs',
    table: 'activity',
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
  });
}

describe('BigQueryGmailConnector', () => {
  it('lists a single Gmail-logs scope from the configured dataset/table', async () => {
    const c = connector(vi.fn());
    expect(await c.listAuditScopes()).toEqual([
      { scopeKey: 'workspace_logs.activity', label: 'Gmail logs (BigQuery)' },
    ]);
  });

  it('POSTs a parameterized query to the jobs.query endpoint for the first page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(bqResponse(SAMPLE));
    await connector(fetchImpl).fetchAuditPage('workspace_logs.activity', {
      since: '2026-07-01T00:00:00.000Z',
      until: '2026-07-08T00:00:00.000Z',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/bigquery/v2/projects/proj-x/queries');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      query: string;
      queryParameters: { name: string; parameterValue: { value: string } }[];
    };
    expect(body.query).toContain('proj-x.workspace_logs.activity');
    expect(body.query).toContain('mail_event_type');
    expect(body.queryParameters.find((p) => p.name === 'since')?.parameterValue.value).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('decodes rows into audit records, mapping mail_event_type to a readable operation', async () => {
    const page = await connector(vi.fn().mockResolvedValue(bqResponse(SAMPLE))).fetchAuditPage(
      'workspace_logs.activity',
      { since: '2026-07-01T00:00:00.000Z', until: '2026-07-08T00:00:00.000Z' },
    );
    const records = page.batches[0]?.records ?? [];
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      system: 'google_bigquery_gmail',
      operation: 'Message viewed',
      recordType: 'gmail_mail_event:31',
      workload: 'gmail',
      actorEmail: 'avery.chen@example.com',
      actorIp: '203.0.113.7',
      targetId: '<q3@mail.example.com>',
      occurredAt: '2026-07-01T12:00:00Z',
    });
    expect(records[1]?.operation).toBe('Message opened (first time)');
    // Raw row is preserved as a name->value object for the record.
    expect((records[0]?.raw as Record<string, unknown>)['subject']).toBe('Q3 vendor contract');
  });

  it('follows the BigQuery pageToken via getQueryResults on the next page', async () => {
    const firstPage = { ...SAMPLE, pageToken: 'pt-2' };
    const c = connector(vi.fn().mockResolvedValue(bqResponse(firstPage)));
    const page1 = await c.fetchAuditPage('workspace_logs.activity', {
      since: '2026-07-01T00:00:00.000Z',
      until: '2026-07-08T00:00:00.000Z',
    });
    expect(page1.nextCursor).toBeDefined();

    const fetchImpl = vi.fn().mockResolvedValue(bqResponse({ ...SAMPLE, pageToken: undefined }));
    const c2 = connector(fetchImpl);
    const page2 = await c2.fetchAuditPage('workspace_logs.activity', {
      cursor: page1.nextCursor,
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method ?? 'GET').toBe('GET');
    expect(url).toContain('/queries/job-1');
    expect(url).toContain('pageToken=pt-2');
    expect(page2.nextCursor).toBeUndefined();
  });
});
