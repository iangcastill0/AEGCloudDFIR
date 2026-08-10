# Fake provider fixture layout

`startFakeProviderServer(fixtureDir)` (entrypoint `@evidencevault/connectors/fake`)
serves Graph-shaped and Gmail/Drive-shaped JSON from a fixture directory.
The canonical sanitized fixture set used by this package's tests lives at
`packages/connectors/fixtures/`. All fixtures are small and sanitized
(`@example.com` addresses only). The fake server is for tests and the
clearly-labeled demo mode only.

## Conventions

- `{{BASE}}` inside any JSON fixture is replaced with the running server's
  base URL (used for `@odata.nextLink` / `@odata.deltaLink` values).
- Graph-style paging: `?page=N` selects `<name>.pageN.json` (default page 1);
  `?token=T` selects `<name>.token-T.json`; `token=expired` returns HTTP 410.
- Google-style paging: the `pageToken` query value names the file suffix
  (`pageToken=page2` → `<name>.page2.json`; absent → `page1`).
- `?flaky=1` on any GET: the first hit of that exact URL returns
  `429 Retry-After: 1`, subsequent hits succeed (throttling tests).
- Gmail `format=raw` responses are assembled at serve time from
  `google/message.<id>.json` (metadata) plus `google/message.<id>.eml`
  (base64url-encoded into `raw`), keeping fixtures readable.
- Graph `/drives/{d}/items/{i}/content` responds `302 Location:
  {{BASE}}/download/ms/{i}?tempauth=...`; the download route serves
  `microsoft/content.<i>.bin` and must be called WITHOUT an Authorization
  header (the request log records whether one was sent).
- Custodian `no-recoverable@example.com` gets a 403 for the
  recoverable-items-deletions folder (permission-exception tests).

## Directory layout

```
<fixtureDir>/
  microsoft/
    token.json                          # POST /{tenant}/oauth2/v2.0/token
    mailFolders.page1.json ...          # GET /graph/(me|users/{u})/mailFolders
    childFolders.<folderId>.json        # GET .../mailFolders/{id}/childFolders
    recoverableitemsdeletions.json      # GET .../mailFolders/recoverableitemsdeletions
    messages.<folderId>.page<N>.json    # GET .../mailFolders/{id}/messages
    mailDelta.<folderId>.page<N>.json   # GET .../mailFolders/{id}/messages/delta
    mailDelta.<folderId>.token-<T>.json # delta resume pages
    message.<id>.json                   # GET .../messages/{id} (full metadata)
    message.<id>.eml                    # GET .../messages/{id}/$value (RFC822)
    drive.json / drives.json            # GET .../drive, .../drives
    driveDelta.<driveId>.page<N>.json   # GET /graph/drives/{id}/root/delta
    driveDelta.<driveId>.token-<T>.json
    content.<itemId>.bin                # GET /download/ms/{itemId} (after 302)
    users.page<N>.json, users.search.json  # GET /graph/users
  google/
    token.json                          # POST /token
    labels.json                         # GET /google/gmail/v1/users/me/labels
    messages.page<N>.json               # GET .../messages (list)
    message.<id>.json + message.<id>.eml# GET .../messages/{id}?format=raw
    history.page<N>.json                # GET .../history
    drives.page<N>.json                 # GET /google/drive/v3/drives
    files.page<N>.json                  # GET /google/drive/v3/files
    file.<id>.json                      # GET /google/drive/v3/files/{id} (path lookup)
    content.<id>.bin                    # GET /google/drive/v3/files/{id}?alt=media
    export.<id>.<ext>.bin               # GET /google/drive/v3/files/{id}/export
    startPageToken.json                 # GET /google/drive/v3/changes/startPageToken
    changes.<pageToken>.json            # GET /google/drive/v3/changes
    users.page<N>.json, users.search.json  # GET /google/admin/directory/v1/users
```

Connector base URLs for a server at `URL`:

- `msGraphBaseUrl` = `URL/graph`
- `msLoginBaseUrl` = `URL`
- `googleApiBaseUrl` = `URL/google`
- `googleOauthTokenUrl` = `URL/token`
