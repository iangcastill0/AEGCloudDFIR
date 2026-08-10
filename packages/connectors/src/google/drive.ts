/**
 * Google Drive connector: files.list / drives.list / changes.list with
 * supportsAllDrives, provider checksums preserved as metadata, path
 * reconstruction via a memoized parent-chain resolver, binary downloads via
 * alt=media and Google-native exports via files.export (flagged
 * apiExportDerivative:true, never presented as the stored native).
 */
import { z } from 'zod';
import { ensureOk, providerFetch } from '../http.js';
import {
  NonDownloadableError,
  type DriveConnector,
  type DriveContent,
  type DriveEntry,
  type DriveInfo,
  type DriveListPage,
  type FetchContentOptions,
  type ListFilesOptions,
} from '../types.js';
import { googleFetchOptions, normalizeBaseUrl, type GoogleConnectorOptions } from './common.js';

export interface GoogleExportTarget {
  mimeType: string;
  extension: string;
}

const PDF: GoogleExportTarget = { mimeType: 'application/pdf', extension: 'pdf' };

/** Contract export mapping: docs→pdf+docx, sheets→pdf+xlsx, slides→pdf+pptx, drawings→pdf. */
export const GOOGLE_EXPORT_MAP: Record<string, readonly GoogleExportTarget[]> = {
  'application/vnd.google-apps.document': [
    PDF,
    {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: 'docx',
    },
  ],
  'application/vnd.google-apps.spreadsheet': [
    PDF,
    {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
    },
  ],
  'application/vnd.google-apps.presentation': [
    PDF,
    {
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: 'pptx',
    },
  ],
  'application/vnd.google-apps.drawing': [PDF],
};

const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

const FILE_FIELDS =
  'id,name,mimeType,md5Checksum,sha256Checksum,size,parents,owners(displayName,emailAddress),permissions(id,type,role,emailAddress),createdTime,modifiedTime,trashed,driveId,version';

const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  md5Checksum: z.string().optional(),
  sha256Checksum: z.string().optional(),
  size: z.union([z.string(), z.number()]).optional(),
  parents: z.array(z.string()).optional(),
  owners: z
    .array(z.object({ displayName: z.string().optional(), emailAddress: z.string().optional() }))
    .optional(),
  permissions: z.array(z.unknown()).optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  trashed: z.boolean().optional(),
  driveId: z.string().optional(),
  version: z.union([z.string(), z.number()]).optional(),
});

const fileListSchema = z.object({
  files: z.array(fileSchema).default([]),
  nextPageToken: z.string().optional(),
});

const driveListSchema = z.object({
  drives: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

const pathNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  parents: z.array(z.string()).optional(),
});

const startPageTokenSchema = z.object({ startPageToken: z.string() });

const changeListSchema = z.object({
  changes: z
    .array(
      z.object({
        fileId: z.string().optional(),
        removed: z.boolean().optional(),
        file: fileSchema.optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
  newStartPageToken: z.string().optional(),
});

const errorReasonSchema = z.object({
  error: z
    .object({
      errors: z.array(z.object({ reason: z.string().optional() })).optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const MAX_PATH_DEPTH = 50;

export class GoogleDriveConnector implements DriveConnector {
  private readonly base: string;
  /** Memoized id → node lookups for path reconstruction. */
  private readonly pathCache = new Map<string, z.infer<typeof pathNodeSchema>>();

  constructor(private readonly options: GoogleConnectorOptions) {
    this.base = normalizeBaseUrl(options.googleApiBaseUrl);
  }

  private driveUrl(pathSuffix: string): string {
    return `${this.base}/drive/v3${pathSuffix}`;
  }

  private async get(url: string): Promise<Response> {
    return providerFetch(url, { method: 'GET' }, googleFetchOptions(this.options));
  }

  async listDrives(_custodian: string): Promise<DriveInfo[]> {
    const drives: DriveInfo[] = [];
    let pageToken: string | undefined;
    do {
      const u = new URL(this.driveUrl('/drives'));
      u.searchParams.set('pageSize', '100');
      if (pageToken !== undefined) u.searchParams.set('pageToken', pageToken);
      const res = await ensureOk(await this.get(u.toString()), 'listDrives');
      const page = driveListSchema.parse(await res.json());
      drives.push(...page.drives.map((d) => ({ id: d.id, name: d.name, driveType: 'shared' })));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return drives;
  }

  async listFiles(custodian: string, opts: ListFilesOptions = {}): Promise<DriveListPage> {
    let url: string;
    if (opts.cursor !== undefined) {
      url = opts.cursor; // opaque: a fully-built files.list URL
    } else {
      const u = new URL(this.driveUrl('/files'));
      u.searchParams.set('pageSize', '100');
      u.searchParams.set('supportsAllDrives', 'true');
      u.searchParams.set('includeItemsFromAllDrives', 'true');
      u.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
      const q: string[] = [
        opts.includeTrashed === true ? '(trashed = true or trashed = false)' : 'trashed = false',
      ];
      if (opts.folderId !== undefined) q.push(`'${opts.folderId.replace(/'/g, "\\'")}' in parents`);
      u.searchParams.set('q', q.join(' and '));
      if (opts.driveId !== undefined) {
        u.searchParams.set('driveId', opts.driveId);
        u.searchParams.set('corpora', 'drive');
      }
      url = u.toString();
    }
    const res = await ensureOk(await this.get(url), 'listFiles');
    const page = fileListSchema.parse(await res.json());
    const items: DriveEntry[] = [];
    for (const file of page.files) {
      items.push(await this.mapFile(file));
    }
    let nextCursor: string | undefined;
    if (page.nextPageToken !== undefined) {
      const nextUrl = new URL(url);
      nextUrl.searchParams.set('pageToken', page.nextPageToken);
      nextCursor = nextUrl.toString();
    }
    return { items, nextCursor };
  }

  private async mapFile(file: z.infer<typeof fileSchema>): Promise<DriveEntry> {
    const checksums: Record<string, string> = {};
    if (file.md5Checksum !== undefined) checksums['md5'] = file.md5Checksum;
    if (file.sha256Checksum !== undefined) checksums['sha256'] = file.sha256Checksum;
    const isFolder = file.mimeType === GOOGLE_FOLDER_MIME;
    const isGoogleNative = !isFolder && file.mimeType.startsWith(GOOGLE_NATIVE_PREFIX);
    const owner = file.owners?.[0];
    return {
      providerItemId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size !== undefined ? Number(file.size) : undefined,
      path: await this.resolvePath(file),
      parentId: file.parents?.[0],
      checksums,
      createdAt: file.createdTime,
      modifiedAt: file.modifiedTime,
      createdBy: owner?.emailAddress ?? owner?.displayName,
      trashed: file.trashed,
      sharedSummary: file.permissions,
      driveId: file.driveId,
      isFolder,
      downloadable: !isFolder && (!isGoogleNative || file.mimeType in GOOGLE_EXPORT_MAP),
      googleNativeType: isGoogleNative ? file.mimeType : undefined,
      versionId: file.version !== undefined ? String(file.version) : undefined,
    };
  }

  /** Memoized files.get id→{name,parents} lookup, capped at depth 50. */
  private async lookupNode(id: string): Promise<z.infer<typeof pathNodeSchema> | undefined> {
    const cached = this.pathCache.get(id);
    if (cached !== undefined) return cached;
    const u = new URL(this.driveUrl(`/files/${encodeURIComponent(id)}`));
    u.searchParams.set('fields', 'id,name,parents');
    u.searchParams.set('supportsAllDrives', 'true');
    const res = await this.get(u.toString());
    if (res.status === 404) return undefined;
    await ensureOk(res, 'resolvePath(files.get)');
    const node = pathNodeSchema.parse(await res.json());
    this.pathCache.set(id, node);
    return node;
  }

  private async resolvePath(file: z.infer<typeof fileSchema>): Promise<string> {
    const segments: string[] = [file.name];
    let parentId = file.parents?.[0];
    for (let depth = 0; parentId !== undefined && depth < MAX_PATH_DEPTH; depth += 1) {
      const node = await this.lookupNode(parentId);
      if (node === undefined) break;
      if (node.parents === undefined || node.parents.length === 0) {
        // Root ('My Drive' or a shared-drive root): excluded from the path.
        break;
      }
      segments.unshift(node.name);
      parentId = node.parents[0];
    }
    return `/${segments.join('/')}`;
  }

  async fetchContent(
    _custodian: string,
    entry: DriveEntry,
    opts: FetchContentOptions = {},
  ): Promise<DriveContent> {
    if (entry.isFolder) {
      throw new NonDownloadableError('folders have no downloadable content', {
        kind: 'unsupported_item',
        providerItemId: entry.providerItemId,
      });
    }
    if (entry.googleNativeType !== undefined) {
      return this.exportNative(entry, opts);
    }
    const u = new URL(this.driveUrl(`/files/${encodeURIComponent(entry.providerItemId)}`));
    u.searchParams.set('alt', 'media');
    u.searchParams.set('supportsAllDrives', 'true');
    const res = await this.get(u.toString());
    if (res.status === 404) {
      throw new NonDownloadableError('drive file content is not available (HTTP 404)', {
        kind: 'unavailable_item',
        providerItemId: entry.providerItemId,
      });
    }
    await ensureOk(res, 'fetchContent');
    return {
      stream: res.body ?? new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? undefined,
      apiExportDerivative: false,
    };
  }

  private async exportNative(
    entry: DriveEntry,
    opts: FetchContentOptions,
  ): Promise<DriveContent> {
    const nativeType = entry.googleNativeType ?? entry.mimeType;
    const targets = GOOGLE_EXPORT_MAP[nativeType];
    if (targets === undefined || targets.length === 0) {
      throw new NonDownloadableError(
        `no export mapping is configured for Google-native type ${nativeType}`,
        { kind: 'unsupported_item', providerItemId: entry.providerItemId },
      );
    }
    const target =
      opts.exportMimeType !== undefined
        ? targets.find((t) => t.mimeType === opts.exportMimeType)
        : targets[0];
    if (target === undefined) {
      throw new NonDownloadableError(
        `requested export type is not configured for ${nativeType}`,
        { kind: 'unsupported_item', providerItemId: entry.providerItemId },
      );
    }
    const u = new URL(this.driveUrl(`/files/${encodeURIComponent(entry.providerItemId)}/export`));
    u.searchParams.set('mimeType', target.mimeType);
    const res = await this.get(u.toString());
    if (res.status === 403) {
      const body = errorReasonSchema.safeParse(await res.json().catch(() => ({})));
      const reasons =
        body.success && body.data.error?.errors !== undefined
          ? body.data.error.errors.map((e) => e.reason)
          : [];
      if (reasons.includes('exportSizeLimitExceeded')) {
        throw new NonDownloadableError(
          'google-native document exceeds the files.export size limit (exportSizeLimitExceeded)',
          { kind: 'non_downloadable', providerItemId: entry.providerItemId },
        );
      }
      throw new NonDownloadableError('export was denied by the provider (HTTP 403)', {
        kind: 'permission_denied',
        providerItemId: entry.providerItemId,
      });
    }
    await ensureOk(res, 'fetchContent(export)');
    return {
      stream: res.body ?? new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? target.mimeType,
      apiExportDerivative: true,
      exportFormat: target.extension,
      sourceNativeMimeType: nativeType,
    };
  }

  async getChangesDelta(_custodian: string, deltaCursor?: string): Promise<DriveListPage> {
    let token = deltaCursor;
    if (token === undefined || token === '') {
      const u = new URL(this.driveUrl('/changes/startPageToken'));
      u.searchParams.set('supportsAllDrives', 'true');
      const res = await ensureOk(await this.get(u.toString()), 'getChangesDelta(startPageToken)');
      token = startPageTokenSchema.parse(await res.json()).startPageToken;
    }
    const u = new URL(this.driveUrl('/changes'));
    u.searchParams.set('pageToken', token);
    u.searchParams.set('pageSize', '100');
    u.searchParams.set('supportsAllDrives', 'true');
    u.searchParams.set('includeItemsFromAllDrives', 'true');
    u.searchParams.set('includeRemoved', 'true');
    u.searchParams.set(
      'fields',
      `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
    );
    const res = await ensureOk(await this.get(u.toString()), 'getChangesDelta');
    const page = changeListSchema.parse(await res.json());
    const items: DriveEntry[] = [];
    for (const change of page.changes) {
      if (change.removed === true || change.file === undefined) {
        if (change.fileId !== undefined) {
          items.push({
            providerItemId: change.fileId,
            name: '',
            mimeType: 'application/octet-stream',
            path: '',
            checksums: {},
            trashed: true,
            isFolder: false,
            downloadable: false,
          });
        }
        continue;
      }
      items.push(await this.mapFile(change.file));
    }
    return { items, nextCursor: page.nextPageToken, deltaCursor: page.newStartPageToken };
  }
}
