/**
 * OneDrive / SharePoint drive connector over Microsoft Graph.
 *
 * Traversal uses /drives/{id}/root/delta (also the incremental mechanism);
 * content downloads follow the Graph 302 to a pre-authenticated URL WITHOUT
 * forwarding the bearer token. Items without a downloadable native (folders,
 * OneNote packages, deleted stubs) surface as NonDownloadableError so callers
 * record an explicit exception instead of a fabricated native.
 */
import { z } from 'zod';
import { ensureOk, followRedirectWithoutAuth, providerFetch } from '../http.js';
import {
  DeltaExpiredError,
  NonDownloadableError,
  type DriveConnector,
  type DriveContent,
  type DriveEntry,
  type DriveInfo,
  type DriveListPage,
  type ListFilesOptions,
} from '../types.js';
import {
  graphFetchOptions,
  normalizeBaseUrl,
  userSegment,
  type GraphConnectorOptions,
} from './common.js';

const identitySchema = z.object({
  user: z
    .object({
      displayName: z.string().optional(),
      email: z.string().optional(),
      id: z.string().optional(),
    })
    .optional(),
});

const driveItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  eTag: z.string().optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  createdBy: identitySchema.optional(),
  lastModifiedBy: identitySchema.optional(),
  parentReference: z
    .object({
      id: z.string().optional(),
      driveId: z.string().optional(),
      path: z.string().optional(),
    })
    .optional(),
  file: z
    .object({
      mimeType: z.string().optional(),
      hashes: z
        .object({
          quickXorHash: z.string().optional(),
          sha256Hash: z.string().optional(),
          sha1Hash: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  folder: z.object({ childCount: z.number().optional() }).optional(),
  package: z.object({ type: z.string().optional() }).optional(),
  deleted: z.object({ state: z.string().optional() }).optional(),
  shared: z.unknown().optional(),
});

const deltaPageSchema = z.object({
  value: z.array(driveItemSchema),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
});

const driveSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  driveType: z.string().optional(),
});

const driveListSchema = z.object({ value: z.array(driveSchema) });

/** Strip Graph's '/drive/root:' or '/drives/{id}/root:' prefix from a parent path. */
export function cleanGraphParentPath(path: string | undefined): string {
  if (path === undefined) return '';
  const marker = 'root:';
  const idx = path.indexOf(marker);
  return idx === -1 ? path : path.slice(idx + marker.length);
}

function identityString(id: z.infer<typeof identitySchema> | undefined): string | undefined {
  const user = id?.user;
  if (user === undefined) return undefined;
  return user.email ?? user.displayName ?? user.id;
}

export class GraphDriveConnector implements DriveConnector {
  private readonly base: string;

  constructor(private readonly options: GraphConnectorOptions) {
    this.base = normalizeBaseUrl(options.graphBaseUrl);
  }

  private seg(custodian: string): string {
    return userSegment(this.options.mode, custodian);
  }

  private async get(url: string, init: RequestInit = { method: 'GET' }): Promise<Response> {
    return providerFetch(url, init, graphFetchOptions(this.options));
  }

  async listDrives(custodian: string): Promise<DriveInfo[]> {
    const seg = this.seg(custodian);
    const found = new Map<string, DriveInfo>();

    const defaultRes = await this.get(`${this.base}${seg}/drive`);
    if (defaultRes.ok) {
      const d = driveSchema.parse(await defaultRes.json());
      found.set(d.id, { id: d.id, name: d.name ?? 'OneDrive', driveType: d.driveType });
    } else if (defaultRes.status !== 404) {
      await ensureOk(defaultRes, 'listDrives(default)');
    }

    const listRes = await this.get(`${this.base}${seg}/drives`);
    if (listRes.ok) {
      for (const d of driveListSchema.parse(await listRes.json()).value) {
        found.set(d.id, { id: d.id, name: d.name ?? 'OneDrive', driveType: d.driveType });
      }
    } else if (listRes.status !== 404) {
      await ensureOk(listRes, 'listDrives');
    }
    return [...found.values()];
  }

  async listFiles(custodian: string, opts: ListFilesOptions = {}): Promise<DriveListPage> {
    const url =
      opts.cursor ??
      (opts.driveId !== undefined
        ? `${this.base}/drives/${encodeURIComponent(opts.driveId)}/root/delta?$top=200`
        : `${this.base}${this.seg(custodian)}/drive/root/delta?$top=200`);
    const res = await this.get(url);
    if (res.status === 410) {
      throw new DeltaExpiredError('drive delta checkpoint expired; restart full enumeration');
    }
    await ensureOk(res, 'listFiles(delta)');
    const page = deltaPageSchema.parse(await res.json());
    return {
      items: page.value.map((item) => this.mapItem(item, opts.driveId)),
      nextCursor: page['@odata.nextLink'],
      deltaCursor: page['@odata.deltaLink'],
    };
  }

  async getChangesDelta(custodian: string, deltaCursor?: string): Promise<DriveListPage> {
    return this.listFiles(custodian, { cursor: deltaCursor });
  }

  private mapItem(item: z.infer<typeof driveItemSchema>, fallbackDriveId?: string): DriveEntry {
    const checksums: Record<string, string> = {};
    const hashes = item.file?.hashes;
    if (hashes?.quickXorHash !== undefined) checksums['quickXorHash'] = hashes.quickXorHash;
    if (hashes?.sha256Hash !== undefined) checksums['sha256'] = hashes.sha256Hash;
    if (hashes?.sha1Hash !== undefined) checksums['sha1'] = hashes.sha1Hash;

    const isFolder = item.folder !== undefined;
    const isPackage = item.package !== undefined;
    const isDeleted = item.deleted !== undefined;
    const name = item.name ?? '';
    const parentPath = cleanGraphParentPath(item.parentReference?.path);

    return {
      providerItemId: item.id,
      name,
      mimeType:
        item.file?.mimeType ??
        (isFolder
          ? 'application/vnd.microsoft.graph.folder'
          : isPackage
            ? 'application/vnd.microsoft.graph.package'
            : 'application/octet-stream'),
      size: item.size,
      path: `${parentPath}/${name}`,
      parentId: item.parentReference?.id,
      checksums,
      createdAt: item.createdDateTime,
      modifiedAt: item.lastModifiedDateTime,
      createdBy: identityString(item.createdBy),
      modifiedBy: identityString(item.lastModifiedBy),
      trashed: isDeleted ? true : undefined,
      sharedSummary: item.shared,
      driveId: item.parentReference?.driveId ?? fallbackDriveId,
      isFolder,
      downloadable: item.file !== undefined && !isPackage && !isDeleted,
      versionId: item.eTag,
    };
  }

  async fetchContent(custodian: string, entry: DriveEntry): Promise<DriveContent> {
    if (!entry.downloadable) {
      throw new NonDownloadableError(
        `drive item has no downloadable native content (${entry.isFolder ? 'folder' : 'package or deleted item'})`,
        {
          kind: entry.isFolder ? 'unsupported_item' : 'non_downloadable',
          providerItemId: entry.providerItemId,
        },
      );
    }
    const driveId = entry.driveId;
    const url =
      driveId !== undefined
        ? `${this.base}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(entry.providerItemId)}/content`
        : `${this.base}${this.seg(custodian)}/drive/items/${encodeURIComponent(entry.providerItemId)}/content`;

    // Manual redirect: the 302 Location is pre-authenticated and must not
    // receive our bearer token.
    const res = await this.get(url, { method: 'GET', redirect: 'manual' });
    let download: Response;
    if (res.status >= 300 && res.status < 400) {
      download = await followRedirectWithoutAuth(res, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: this.options.timeoutMs,
      });
    } else if (res.ok) {
      download = res;
    } else if (res.status === 404) {
      throw new NonDownloadableError('drive item content is not available (HTTP 404)', {
        kind: 'unavailable_item',
        providerItemId: entry.providerItemId,
      });
    } else {
      await ensureOk(res, 'fetchContent');
      download = res; // unreachable; ensureOk throws for !ok
    }
    return {
      stream: download.body ?? new Uint8Array(await download.arrayBuffer()),
      contentType: download.headers.get('content-type') ?? undefined,
      apiExportDerivative: false,
    };
  }
}
