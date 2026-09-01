import { describe, expect, it } from 'vitest';
import { mapTeamLogPage, teamLogRequest } from './team-log.js';

const EVENT = {
  timestamp: '2026-09-01T12:00:00Z',
  event_category: { '.tag': 'file_operations' },
  event_type: { '.tag': 'file_download', description: 'Downloaded files and/or folders' },
  actor: {
    '.tag': 'user',
    user: {
      '.tag': 'team_member',
      account_id: 'dbid:AAA',
      display_name: 'Jane Doe',
      email: 'jane@example.com',
      team_member_id: 'dbmid:AAA1',
    },
  },
  origin: { access_method: { '.tag': 'end_user' }, geo_location: { ip_address: '203.0.113.7' } },
  involve_non_team_member: false,
  assets: [{ '.tag': 'file', path: { contextual: '/Reports/q3.pdf' }, file_id: 'id:f1' }],
};

describe('teamLogRequest', () => {
  it('asks for the whole log when no window is given', () => {
    expect(teamLogRequest({})).toEqual({ limit: 1000 });
  });

  it('sends a time window Dropbox understands', () => {
    // Dropbox wants a `time` object with start_time / end_time, not top-level
    // fields — a common way to get a 400 that reads like a permissions error.
    const body = teamLogRequest({ since: '2026-01-01T00:00:00Z', until: '2026-02-01T00:00:00Z' });
    expect(body.time).toEqual({
      start_time: '2026-01-01T00:00:00Z',
      end_time: '2026-02-01T00:00:00Z',
    });
  });

  it('narrows to a single actor when exactly one was named', () => {
    // More than one actor cannot be expressed, so the filter is dropped rather
    // than silently applying only the first — which would under-collect and
    // report success.
    expect(teamLogRequest({ actorFilter: ['dbmid:AAA1'] }).account_id).toBe('dbmid:AAA1');
    expect(
      teamLogRequest({ actorFilter: ['dbmid:AAA1', 'dbmid:BBB2'] }).account_id,
    ).toBeUndefined();
  });

  it('sends only the cursor when continuing, because Dropbox forbids the rest', () => {
    // /continue takes the cursor ALONE. Re-sending the filters with it is an
    // error, and it is the obvious thing to write.
    expect(teamLogRequest({ cursor: 'CUR', since: '2026-01-01T00:00:00Z' })).toEqual({
      cursor: 'CUR',
    });
  });
});

describe('mapTeamLogPage', () => {
  it('maps an event onto the shared audit record shape', () => {
    const page = mapTeamLogPage(
      { events: [EVENT], cursor: 'CUR', has_more: true },
      'team_events',
      'raw',
    );
    const record = page.batches[0]?.records[0];
    expect(record?.system).toBe('dropbox_team_log');
    expect(record?.operation).toBe('file_download');
    expect(record?.workload).toBe('file_operations');
    expect(record?.actorEmail).toBe('jane@example.com');
    expect(record?.actorIp).toBe('203.0.113.7');
    expect(record?.occurredAt).toBe('2026-09-01T12:00:00Z');
  });

  it('keeps the provider event untouched alongside the parsed fields', () => {
    // The raw element is the evidence; the parsed fields are a convenience.
    const page = mapTeamLogPage({ events: [EVENT], cursor: 'C', has_more: false }, 's', 'raw');
    expect(page.batches[0]?.records[0]?.raw).toEqual(EVENT);
  });

  it('gives every event a distinct id even when timestamps collide', () => {
    // Dropbox does not send an event id. Two events in the same second would
    // otherwise share one id and one would be lost to a dedup upsert.
    const page = mapTeamLogPage(
      { events: [EVENT, EVENT, EVENT], cursor: 'C', has_more: false },
      'team_events',
      'raw',
    );
    const ids = page.batches[0]?.records.map((r) => r.providerRecordId) ?? [];
    expect(new Set(ids).size).toBe(3);
  });

  it('carries the cursor only while more remains', () => {
    expect(mapTeamLogPage({ events: [], cursor: 'C', has_more: true }, 's', 'r').nextCursor).toBe(
      'C',
    );
    expect(
      mapTeamLogPage({ events: [], cursor: 'C', has_more: false }, 's', 'r').nextCursor,
    ).toBeUndefined();
  });

  it('preserves the exact bytes the provider returned', () => {
    const raw = '{"events":[]}';
    const page = mapTeamLogPage({ events: [], cursor: 'C', has_more: false }, 's', raw);
    expect(new TextDecoder().decode(page.batches[0]?.rawBytes)).toBe(raw);
    expect(page.batches[0]?.contentType).toBe('application/json');
  });

  it('survives an actor shape it does not recognise', () => {
    // Dropbox actors can be an app, an admin, "dropbox" itself, or anonymous.
    // An unmapped actor must not lose the event.
    const page = mapTeamLogPage(
      {
        events: [{ ...EVENT, actor: { '.tag': 'dropbox' } }],
        cursor: 'C',
        has_more: false,
      },
      's',
      'r',
    );
    expect(page.batches[0]?.records).toHaveLength(1);
    expect(page.batches[0]?.records[0]?.actorEmail).toBeUndefined();
  });
});
