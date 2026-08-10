/**
 * Google Workspace custodian directory (Admin SDK Directory API, read-only).
 * Requires the admin.directory.user.readonly DWD scope with an admin subject.
 */
import { z } from 'zod';
import { ensureOk, providerFetch } from '../http.js';
import type { CustodianDirectory, DirectoryUserPage, ListUsersOptions } from '../types.js';
import { googleFetchOptions, normalizeBaseUrl, type GoogleConnectorOptions } from './common.js';

const userSchema = z.object({
  id: z.string(),
  primaryEmail: z.string(),
  name: z.object({ fullName: z.string().optional() }).optional(),
});

const userPageSchema = z.object({
  users: z.array(userSchema).default([]),
  nextPageToken: z.string().optional(),
});

export class GoogleCustodianDirectory implements CustodianDirectory {
  private readonly base: string;

  constructor(private readonly options: GoogleConnectorOptions) {
    this.base = normalizeBaseUrl(options.googleApiBaseUrl);
  }

  async listUsers(opts: ListUsersOptions = {}): Promise<DirectoryUserPage> {
    const u = new URL(`${this.base}/admin/directory/v1/users`);
    u.searchParams.set('customer', 'my_customer');
    u.searchParams.set('maxResults', '100');
    const search = opts.search?.trim() ?? '';
    if (search !== '') u.searchParams.set('query', search);
    if (opts.cursor !== undefined) u.searchParams.set('pageToken', opts.cursor);
    const res = await ensureOk(
      await providerFetch(u.toString(), { method: 'GET' }, googleFetchOptions(this.options)),
      'listUsers',
    );
    const page = userPageSchema.parse(await res.json());
    return {
      users: page.users.map((user) => ({
        externalId: user.id,
        email: user.primaryEmail,
        displayName: user.name?.fullName ?? user.primaryEmail,
      })),
      nextCursor: page.nextPageToken,
    };
  }
}
