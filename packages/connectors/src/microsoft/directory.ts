/**
 * Entra ID custodian directory (organization mode): Graph /users with
 * $search (ConsistencyLevel: eventual) and nextLink paging.
 */
import { z } from 'zod';
import { ensureOk, providerFetch } from '../http.js';
import {
  ConnectorError,
  type CustodianDirectory,
  type DirectoryUserPage,
  type ListUsersOptions,
} from '../types.js';
import { graphFetchOptions, normalizeBaseUrl, type GraphConnectorOptions } from './common.js';

/**
 * Graph @odata.nextLink is stored as the paging cursor and sent back on
 * GET /connectors/:id/custodians?cursor=. providerFetch always attaches the
 * connector bearer token, so the cursor must be a users listing on the
 * configured Graph host — not an attacker URL.
 */
export function graphUsersCursorUrl(graphBaseUrl: string, cursor: string): string {
  const base = new URL(normalizeBaseUrl(graphBaseUrl));
  let next: URL;
  try {
    next = new URL(cursor);
  } catch {
    throw new ConnectorError('paging cursor is not a valid URL');
  }
  if (next.username !== '' || next.password !== '') {
    throw new ConnectorError('paging cursor must not carry credentials');
  }
  if (next.origin !== base.origin) {
    throw new ConnectorError('paging cursor is not on the configured Graph host');
  }
  const expectedPath = `${base.pathname.replace(/\/$/, '')}/users`;
  const path = next.pathname.endsWith('/') ? next.pathname.slice(0, -1) : next.pathname;
  if (path !== expectedPath) {
    throw new ConnectorError('paging cursor is not a Graph users listing URL');
  }
  return next.toString();
}

const userSchema = z.object({
  id: z.string(),
  mail: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  userPrincipalName: z.string().optional(),
});

const userPageSchema = z.object({
  value: z.array(userSchema),
  '@odata.nextLink': z.string().optional(),
});

export type GraphDirectoryOptions = Omit<GraphConnectorOptions, 'mode'>;

export class GraphCustodianDirectory implements CustodianDirectory {
  private readonly base: string;

  constructor(private readonly options: GraphDirectoryOptions) {
    this.base = normalizeBaseUrl(options.graphBaseUrl);
  }

  async listUsers(opts: ListUsersOptions = {}): Promise<DirectoryUserPage> {
    let url: string;
    const search = opts.search?.trim() ?? '';
    const searching = search !== '';
    if (opts.cursor !== undefined) {
      url = graphUsersCursorUrl(this.base, opts.cursor);
    } else {
      const u = new URL(`${this.base}/users`);
      u.searchParams.set('$select', 'id,mail,displayName,userPrincipalName');
      u.searchParams.set('$top', '100');
      if (searching) {
        const escaped = search.replace(/"/g, '');
        u.searchParams.set('$search', `"displayName:${escaped}" OR "mail:${escaped}"`);
        u.searchParams.set('$count', 'true');
      }
      url = u.toString();
    }
    const headers: Record<string, string> = searching ? { ConsistencyLevel: 'eventual' } : {};
    const res = await ensureOk(
      await providerFetch(
        url,
        { method: 'GET', headers },
        graphFetchOptions({ ...this.options, mode: 'organization' }),
      ),
      'listUsers',
    );
    const page = userPageSchema.parse(await res.json());
    return {
      users: page.value.map((u) => ({
        externalId: u.id,
        email: u.mail ?? u.userPrincipalName ?? '',
        displayName: u.displayName ?? u.userPrincipalName ?? '',
      })),
      nextCursor: page['@odata.nextLink'],
    };
  }
}
