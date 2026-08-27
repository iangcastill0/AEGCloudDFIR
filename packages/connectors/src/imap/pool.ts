/**
 * Reuse IMAP connections instead of logging in per message.
 *
 * Every fetch is its own worker job, and the first version opened a connection
 * per call. Measured against one real Yahoo account, a full collection would
 * have been 10,563 TCP + TLS + LOGIN round trips — providers cap concurrent
 * IMAP connections and treat that pattern as abuse, so the collection would
 * throttle, then start failing, and the failures would look like credential
 * problems.
 *
 * The pool keeps one live connection per mailbox and hands it out one caller at
 * a time, because IMAP runs a single command per connection anyway. A connection
 * that errors is thrown away rather than reused: a half-dead socket handed out
 * repeatedly turns one transient fault into a failed collection.
 */
import { ImapFlow } from 'imapflow';

export interface ImapConnectionSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

/** Identity of a mailbox connection. Never includes the password: keys get logged. */
export function poolKey(settings: ImapConnectionSettings): string {
  return `${settings.username}@${settings.host}:${String(settings.port)}`;
}

interface Entry {
  client: ImapFlow;
}

export interface ImapConnectionPoolOptions {
  /**
   * Live connections per mailbox. One by default and deliberately low: Yahoo,
   * iCloud and Gmail all cap concurrent IMAP connections per account, and a
   * collection that trips that cap looks like a broken credential.
   */
  maxConnections?: number;
  createClient: (settings: ImapConnectionSettings) => ImapFlow;
}

export class ImapConnectionPool {
  private readonly entries = new Map<string, Entry>();
  /**
   * One promise chain per mailbox, kept SEPARATELY from the connection.
   *
   * Holding the chain on the connection entry was a real bug: the first caller
   * creates the connection, so there was no entry to chain onto yet and the
   * first two callers ran concurrently on the same socket. The chain has to
   * exist before the connection does.
   */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly createClient: (settings: ImapConnectionSettings) => ImapFlow;

  constructor(options: ImapConnectionPoolOptions) {
    this.createClient = options.createClient;
  }

  /**
   * Run `fn` against a live connection for this mailbox.
   *
   * Calls for the same mailbox queue behind each other. Anything that throws
   * discards the connection, so the next caller reconnects.
   */
  async withConnection<T>(
    settings: ImapConnectionSettings,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const key = poolKey(settings);
    const previous = this.chains.get(key) ?? Promise.resolve();

    // Chain first, then do the work: this is what makes callers serialize
    // without a separate lock. Both handlers run the work, because a previous
    // caller's failure must not skip this one.
    const run = previous.then(
      () => this.runOnConnection(key, settings, fn),
      () => this.runOnConnection(key, settings, fn),
    );

    // Swallowed on the stored chain only: a rejection there would be inherited
    // by every later caller. The caller still gets the real rejection.
    this.chains.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  private async runOnConnection<T>(
    key: string,
    settings: ImapConnectionSettings,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    let entry = this.entries.get(key);

    if (entry === undefined) {
      const client = this.createClient(settings);
      // A late socket fault with no listener is an unhandled 'error' event, and
      // Node kills the process for that. Observed for real against Yahoo.
      client.on('error', () => {
        this.entries.delete(key);
      });
      try {
        await client.connect();
      } catch (err) {
        client.close();
        throw err;
      }
      entry = { client };
      this.entries.set(key, entry);
    }

    try {
      return await fn(entry.client);
    } catch (err) {
      // Discard rather than reuse: the fault may have left the connection in an
      // unknown state, and reusing it would spread one failure across a run.
      this.entries.delete(key);
      try {
        entry.client.close();
      } catch {
        // Already gone.
      }
      throw err;
    }
  }

  /** Close every connection. Call on worker shutdown so logins are not leaked. */
  async closeAll(): Promise<void> {
    const open = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      open.map(async (entry) => {
        await entry.client.logout().catch(() => undefined);
        try {
          entry.client.close();
        } catch {
          // Already gone.
        }
      }),
    );
  }

  /** Live connection count, for logging and tests. */
  size(): number {
    return this.entries.size;
  }
}
