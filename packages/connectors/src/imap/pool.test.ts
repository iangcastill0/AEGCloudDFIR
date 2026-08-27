import { describe, expect, it, vi } from 'vitest';
import { ImapConnectionPool, poolKey } from './pool';

interface FakeConn {
  id: number;
  connected: boolean;
  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function factory(opts: { failConnect?: boolean } = {}) {
  let next = 0;
  const made: FakeConn[] = [];
  const create = vi.fn(() => {
    next += 1;
    const conn: FakeConn = {
      id: next,
      connected: false,
      connect: vi.fn(async () => {
        if (opts.failConnect === true) throw new Error('AUTHENTICATIONFAILED');
        conn.connected = true;
      }),
      logout: vi.fn(async () => undefined),
      close: vi.fn(() => {
        conn.connected = false;
      }),
      on: vi.fn(),
    };
    made.push(conn);
    return conn as unknown as never;
  });
  return { create, made };
}

const SETTINGS = {
  host: 'imap.mail.yahoo.com',
  port: 993,
  secure: true,
  username: 'someone@yahoo.com',
  password: 'app-password',
};

describe('poolKey', () => {
  it('separates different mailboxes on the same host', () => {
    expect(poolKey({ ...SETTINGS, username: 'a@yahoo.com' })).not.toBe(
      poolKey({ ...SETTINGS, username: 'b@yahoo.com' }),
    );
  });

  it('separates different hosts for the same login', () => {
    expect(poolKey(SETTINGS)).not.toBe(poolKey({ ...SETTINGS, host: 'imap.aol.com' }));
  });

  it('never includes the password, because keys get logged', () => {
    expect(poolKey(SETTINGS)).not.toContain('app-password');
  });
});

describe('ImapConnectionPool', () => {
  it('logs in once and reuses the connection for later work', async () => {
    // The whole point. One login per message meant 10,563 logins for one real
    // mailbox, which is how a provider decides you are abusive.
    const f = factory();
    const pool = new ImapConnectionPool({ maxConnections: 1, createClient: f.create });

    for (let i = 0; i < 5; i += 1) {
      await pool.withConnection(SETTINGS, async () => 'ok');
    }

    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.made[0]?.connect).toHaveBeenCalledTimes(1);
    await pool.closeAll();
  });

  it('keeps one connection per mailbox, not one for everything', async () => {
    const f = factory();
    const pool = new ImapConnectionPool({ maxConnections: 1, createClient: f.create });
    await pool.withConnection(SETTINGS, async () => 'a');
    await pool.withConnection({ ...SETTINGS, username: 'other@yahoo.com' }, async () => 'b');
    expect(f.create).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });

  it('serializes work on one connection, because IMAP takes one command at a time', async () => {
    const f = factory();
    const pool = new ImapConnectionPool({ maxConnections: 1, createClient: f.create });

    const order: string[] = [];
    const slow = pool.withConnection(SETTINGS, async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('first-end');
      return 1;
    });
    const fast = pool.withConnection(SETTINGS, async () => {
      order.push('second-start');
      return 2;
    });
    await Promise.all([slow, fast]);

    // The second must not begin until the first has finished.
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    await pool.closeAll();
  });

  it('throws away a connection that errored, so the next call gets a fresh one', async () => {
    // A half-dead socket that keeps being handed out turns one transient fault
    // into a failed collection.
    const f = factory();
    const pool = new ImapConnectionPool({ maxConnections: 1, createClient: f.create });

    await expect(
      pool.withConnection(SETTINGS, async () => {
        throw new Error('connection reset');
      }),
    ).rejects.toThrow('connection reset');

    expect(f.made[0]?.close).toHaveBeenCalled();
    await pool.withConnection(SETTINGS, async () => 'ok');
    expect(f.create).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });

  it('does not keep a connection that failed to log in', async () => {
    const f = factory({ failConnect: true });
    const pool = new ImapConnectionPool({ maxConnections: 1, createClient: f.create });
    await expect(pool.withConnection(SETTINGS, async () => 'never')).rejects.toThrow();
    expect(f.made[0]?.close).toHaveBeenCalled();
    await pool.closeAll();
  });

  it('closes everything on shutdown, so a worker exit does not leak logins', async () => {
    const f = factory();
    const pool = new ImapConnectionPool({ maxConnections: 1, createClient: f.create });
    await pool.withConnection(SETTINGS, async () => 'ok');
    await pool.closeAll();
    expect(f.made[0]?.logout).toHaveBeenCalled();
    expect(f.made[0]?.close).toHaveBeenCalled();
  });

  it('reopens after closeAll rather than handing back a closed connection', async () => {
    const f = factory();
    const pool = new ImapConnectionPool({ maxConnections: 1, createClient: f.create });
    await pool.withConnection(SETTINGS, async () => 'ok');
    await pool.closeAll();
    await pool.withConnection(SETTINGS, async () => 'ok');
    expect(f.create).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });
});
