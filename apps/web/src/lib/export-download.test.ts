import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCRIPT_PART_THRESHOLD,
  buildBashScript,
  buildHashesTxt,
  buildPowerShellScript,
  buildReadme,
  buildUnverifiablePartsTxt,
  recommendScript,
  saveExportToFolder,
  type DownloadPart,
  type DownloadPlanInput,
} from './export-download';

function part(n: number, overrides: Partial<DownloadPart> = {}): DownloadPart {
  return {
    partNumber: n,
    filename: `export-part${String(n).padStart(3, '0')}.zip`,
    sizeBytes: 1024,
    sha256: String(n).repeat(64).slice(0, 64),
    url: `https://signed/part${String(n)}`,
    ...overrides,
  };
}

const plan: DownloadPlanInput = {
  exportId: '5007e931-f4e4-481a-b273-7817aaaa1db6',
  folderName: 'winder-3-5007e931',
  manifestUrl: 'https://signed/manifest',
  manifestSha256: 'c'.repeat(64),
  parts: [part(1), part(2)],
  downloadToken: 'tok.en',
  apiBaseUrl: 'https://api.aegclouddfir.com',
};

describe('recommendScript', () => {
  /**
   * A browser save has to survive in one sitting: tab open, machine awake, and
   * a failure part-way restarts that part. The 130 GiB export that prompted
   * this feature is 65 parts.
   */
  it('recommends the script once there are many parts', () => {
    const many = Array.from({ length: SCRIPT_PART_THRESHOLD + 1 }, (_, i) => part(i + 1));
    expect(recommendScript(many)).toBe(true);
  });

  it('recommends the script for a small number of very large parts', () => {
    // Part COUNT is not the only cost. Two 8 GiB parts is still hours.
    const huge = [
      part(1, { sizeBytes: 8 * 1024 * 1024 * 1024 }),
      part(2, { sizeBytes: 8 * 1024 * 1024 * 1024 }),
    ];
    expect(recommendScript(huge)).toBe(true);
  });

  it('leaves a small export to the browser', () => {
    expect(recommendScript([part(1), part(2)])).toBe(false);
  });

  it('does not recommend the script just because sizes are unknown', () => {
    // Older exports have no recorded size. Treating unknown as enormous would
    // push every legacy export onto the script path for no reason.
    const unknown = [part(1, { sizeBytes: null }), part(2, { sizeBytes: null })];
    expect(recommendScript(unknown)).toBe(false);
  });
});

describe('buildHashesTxt', () => {
  it('writes sha256sum -c format', () => {
    const text = buildHashesTxt([part(1), part(2)], 'c'.repeat(64));
    expect(text).toContain(`${'1'.repeat(64)}  export-part001.zip`);
    expect(text).toContain(`${'c'.repeat(64)}  manifest.json`);
    expect(text.endsWith('\n')).toBe(true);
  });

  /**
   * Every line a real checksum line, and the same rule as the archive's own
   * hashlist.txt. A `#` comment is read two ways: macOS `sha256sum -c` calls it
   * "improperly formatted" and `--strict` exits 1, while `shasum -a 256 -c`
   * skips it silently. Two answers for one file is not something to hand a
   * recipient who may have to explain it.
   */
  it('puts nothing in the file that is not a checksum line', () => {
    const text = buildHashesTxt([part(1), part(2, { sha256: null })], 'c'.repeat(64));
    for (const line of text.split('\n').filter((l) => l !== '')) {
      expect(line, `${line} is not a DIGEST<2 spaces>FILENAME line`).toMatch(/^[0-9a-f]{64} {2}\S/);
    }
    expect(text).not.toContain('#');
  });

  /**
   * A part with no recorded digest must not simply vanish from the product. A
   * short hashes.txt that passes `-c` looks exactly like a complete one, which
   * would turn "cannot verify" into a silent "verified". It leaves hashes.txt,
   * so it has to turn up in the file next to it.
   */
  it('moves an unverifiable part to its own file rather than dropping it', () => {
    const parts = [part(1), part(2, { sha256: null })];
    expect(buildHashesTxt(parts, '')).not.toContain('export-part002.zip');

    const listed = buildUnverifiablePartsTxt(parts);
    expect(listed).toContain('export-part002.zip');
    expect(listed).toContain('NO recorded digest');
    expect(listed).toContain('hashlist.txt');
    // Never fed to sha256sum, so it must not look like a checksum file.
    expect(listed).not.toMatch(/^[0-9a-f]{64} {2}/m);
  });

  it('writes no unverifiable-parts file when every part has a digest', () => {
    // An empty one reads like something went wrong.
    expect(buildUnverifiablePartsTxt([part(1), part(2)])).toBe('');
  });
});

describe('buildReadme', () => {
  it('gives the verify command for each platform', () => {
    const readme = buildReadme(plan);
    expect(readme).toContain('shasum -a 256 -c hashes.txt');
    expect(readme).toContain('sha256sum -c hashes.txt');
  });

  it('separates checking the transfer from checking the contents', () => {
    // These are different claims. Passing hashes.txt says the parts arrived,
    // not that the evidence inside them is what the manifest says.
    const readme = buildReadme(plan);
    expect(readme).toContain('does not check the contents');
    expect(readme).toContain('hashlist.txt');
  });

  it('warns loudly when parts cannot be verified at all', () => {
    const readme = buildReadme({ ...plan, parts: [part(1), part(2, { sha256: null })] });
    expect(readme).toContain('WARNING');
    expect(readme).toContain('1 of the 2 part(s) here have no recorded');
    // Says where they went, and names the trap: the command passes and the
    // reader thinks everything was checked.
    expect(readme).toContain('unverifiable-parts.txt');
    expect(readme).toContain('report OK');
  });
});

describe('generated scripts', () => {
  /** Both shapes the generator can produce: with and without the extra file. */
  const SCRIPT_CASES: [label: string, input: DownloadPlanInput][] = [
    ['all parts verifiable', plan],
    ['a part with no digest', { ...plan, parts: [part(1), part(2, { sha256: null })] }],
  ];

  it('fetches URLs at run time rather than baking in expiring ones', () => {
    // Presigned URLs last 300s and this download takes hours. A script with
    // them baked in is a script that works once, briefly, and then 403s.
    const sh = buildBashScript(plan);
    expect(sh).toContain('/download/urls');
    expect(sh).not.toContain('https://signed/part1');
  });

  it('resumes a broken part instead of restarting it', () => {
    expect(buildBashScript(plan)).toContain('curl -fsSL -C -');
  });

  it('creates the folder and works from inside it', () => {
    const sh = buildBashScript(plan);
    expect(sh).toContain('mkdir -p "$DIR"');
    expect(sh).toContain("DIR='winder-3-5007e931'");
  });

  it('does not put an export name where the shell would run it', () => {
    const hostile = {
      ...plan,
      folderName: '$(id)`whoami`${IFS}',
    };
    const sh = buildBashScript(hostile);
    const ps = buildPowerShellScript(hostile);
    const dirLine = sh.split('\n').find((line) => line.startsWith('DIR='));
    const psDirLine = ps.split('\n').find((line) => line.includes('$Dir'));
    expect(dirLine).toBe("DIR='id-whoami-IFS'");
    expect(psDirLine).toBe("$Dir      = 'id-whoami-IFS'");
  });

  it('warns that the script holds a credential', () => {
    // It carries a token that reaches this evidence until it expires. A script
    // that does not say so ends up in a shared folder.
    for (const script of [buildBashScript(plan), buildPowerShellScript(plan)]) {
      expect(script).toContain('SECURITY');
      expect(script).toContain('delete it when the download is done');
    }
  });

  it('refreshes and retries when a URL has expired mid-run', () => {
    const sh = buildBashScript(plan);
    expect(sh).toContain('refreshing');
    // The refresh path must re-read the list, not reuse the dead URL.
    expect(sh.match(/refresh_urls/g)?.length ?? 0).toBeGreaterThan(2);
  });

  it('builds a PowerShell script that parses the same endpoint', () => {
    const ps = buildPowerShellScript(plan);
    expect(ps).toContain('Invoke-RestMethod');
    expect(ps).toContain('/download/urls');
    expect(ps).toContain('Bearer $Token');
  });

  /**
   * The browser path writes hashes.txt and README.txt into the folder. The
   * script path used to print "verify with hashes.txt" and never put one
   * there: it downloaded parts and the manifest and nothing else, so the
   * recipient of a 65-part download was told to run a check against a file
   * that did not exist.
   */
  it('puts the verification material in the folder, not just the parts', () => {
    for (const script of [buildBashScript(plan), buildPowerShellScript(plan)]) {
      expect(script).toContain('hashes.txt');
      expect(script).toContain('README.txt');
      // The real digests, not just the filenames.
      expect(script).toContain(`${'1'.repeat(64)}  export-part001.zip`);
      expect(script).toContain('shasum -a 256 -c hashes.txt');
    }
  });

  /**
   * The script folder and the browser folder have to be the same folder. When a
   * part cannot be verified, both write the same extra file, and neither writes
   * it when there is nothing to say.
   */
  it('writes the unverifiable-parts file only when a part has no digest', () => {
    const legacy = { ...plan, parts: [part(1), part(2, { sha256: null })] };
    for (const build of [buildBashScript, buildPowerShellScript]) {
      expect(build(legacy)).toContain('unverifiable-parts.txt');
      expect(build(legacy)).toContain('export-part002.zip');
      expect(build(plan)).not.toContain('unverifiable-parts.txt');
    }
  });

  /**
   * Run the real thing past a real parser, not a regex.
   *
   * This script is built by stitching strings, and the unverifiable-parts block
   * is a heredoc spliced in conditionally. A stray quote makes a file that looks
   * fine in a diff and dies on line 1 for the operator. `bash -n` parses without
   * executing, so nothing is downloaded and nothing is signed.
   */
  it('generates bash that bash itself accepts, with and without the extra block', () => {
    for (const [label, input] of SCRIPT_CASES) {
      const file = join(mkdtempSync(join(tmpdir(), 'cdfir-')), 'download-export.sh');
      writeFileSync(file, buildBashScript(input));
      const result = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(result.status, `${label}: ${result.stderr}`).toBe(0);
      // Warnings too, not just the exit code. bash reports some faults without
      // failing, and "exit 0" is the shape every silent breakage here has had.
      expect(result.stderr, label).toBe('');
    }
  });

  /**
   * And the one fault `bash -n` will NOT catch, checked by hand.
   *
   * Measured: a script whose heredoc is never closed parses clean — exit 0, not
   * a word on stderr — and then swallows the rest of the file at run time. That
   * is precisely the mistake the conditional block above invites, so it needs
   * its own check rather than a comfortable green from bash.
   */
  it('closes every heredoc it opens', () => {
    for (const [label, input] of SCRIPT_CASES) {
      const lines = buildBashScript(input).split('\n');
      const opened: string[] = [];
      for (const line of lines) {
        const start = /<<'([A-Za-z0-9_]+)'/.exec(line);
        if (start?.[1] !== undefined) {
          opened.push(start[1]);
          continue;
        }
        if (opened[0] !== undefined && line === opened[0]) opened.shift();
      }
      expect(opened, `${label}: heredoc(s) left open`).toEqual([]);
    }
  });

  it('never writes a hashes.txt line the checkers disagree about', () => {
    // A `#` line is a warning on macOS sha256sum and an exit-1 with --strict.
    const legacy = { ...plan, parts: [part(1), part(2, { sha256: null })] };
    const sh = buildBashScript(legacy);
    const written = sh.slice(
      sh.indexOf("cat > hashes.txt <<'CDFIR_HASHES_EOF'"),
      sh.indexOf('CDFIR_HASHES_EOF\n', sh.indexOf('CDFIR_HASHES_EOF') + 1),
    );
    expect(written).not.toContain('# export-part002.zip');
  });

  /**
   * `while read ... done < "$LIST"` holds an open descriptor part way through
   * the file. Rewriting that same path from inside the loop truncates it under
   * the reader, so the refresh that was meant to rescue one expired URL could
   * silently end the loop and leave later parts undownloaded.
   */
  it('refreshes into a different file from the one the loop is reading', () => {
    const sh = buildBashScript(plan);
    const loop = sh.slice(sh.indexOf('while IFS='), sh.indexOf('done < '));
    expect(loop).toContain('refresh_urls > "$LIST.new"');
    expect(loop).not.toContain('refresh_urls > "$LIST"');
    expect(sh).toContain('done < "$LIST"');
  });

  /**
   * Re-running is the advertised way to finish an interrupted download, and a
   * finished part has to be recognised as finished. Asking curl to resume one
   * gets a 416, which `-f` turns into a failure and `set -e` turns into a dead
   * script.
   */
  it('skips a part that is already there in full, by size', () => {
    const sh = buildBashScript(plan);
    expect(sh).toContain('export-part001.zip\t1024');
    expect(sh).toContain('already complete');
    expect(sh).toContain('curl -fsSL -C -');
  });

  /**
   * A half-downloaded part is a short file with the right name. Skipping it
   * because the name exists hands over truncated evidence that looks complete
   * in the folder listing.
   */
  it('does not treat a PowerShell file as done just because it exists', () => {
    const ps = buildPowerShellScript(plan);
    expect(ps).toContain('$Sizes');
    expect(ps).toContain('(Get-Item $f.Name).Length -eq $Sizes[$f.Name]');
    // The old shape: present means done.
    expect(ps).not.toMatch(/if \(Test-Path \$f\.Name\) \{\s*\n\s*Write-Host " {2}already present/);
  });
});

// ---------------------------------------------------------------------------
// Saving into a folder the user picked (Chromium)
// ---------------------------------------------------------------------------

/**
 * Enough of FileSystemWritableFileStream to pipe into.
 *
 * It really is a WritableStream, so `body.pipeTo(...)` exercises the streaming
 * path rather than a stub that quietly accepts anything.
 */
class FakeWritable extends WritableStream<Uint8Array | string> {
  async write(chunk: Uint8Array | string): Promise<void> {
    const writer = this.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
  }
}

function fakePicker(): { written: Map<string, string>; folders: string[] } {
  const written = new Map<string, string>();
  const folders: string[] = [];
  const folder = {
    getFileHandle: (name: string) =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve(
            new FakeWritable({
              write(chunk: Uint8Array | string) {
                const text =
                  typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array);
                written.set(name, (written.get(name) ?? '') + text);
              },
            }),
          ),
      }),
  };
  const root = {
    getDirectoryHandle: (name: string) => {
      folders.push(name);
      return Promise.resolve(folder);
    },
  };
  (globalThis as unknown as { window: unknown }).window = {
    showDirectoryPicker: () => Promise.resolve(root),
  };
  return { written, folders };
}

/** A response whose body can only be read as a stream. */
function streamingResponse(body: string, ok = true, status = 200): Response {
  const response = new Response(ok ? body : '', { status });
  const refuse = (): never => {
    throw new Error('buffered the whole body instead of streaming it');
  };
  Object.defineProperty(response, 'arrayBuffer', { value: refuse });
  Object.defineProperty(response, 'text', { value: refuse });
  Object.defineProperty(response, 'blob', { value: refuse });
  return response;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.unstubAllGlobals();
});

describe('saveExportToFolder', () => {
  /**
   * These are 2 GiB files. Reading one into memory to write it out again
   * trades a download problem for an out-of-memory one, so the body must go
   * straight from the response into the file. The fake response throws if
   * anything asks for the whole thing at once.
   */
  it('creates one folder and streams each part into it, still chunked', async () => {
    const { written, folders } = fakePicker();
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(streamingResponse(`bytes-for-${url}`)));

    await saveExportToFolder(plan, () => undefined);

    expect(folders).toEqual(['winder-3-5007e931']);
    // Two parts, two files. Never concatenated into one.
    expect(written.get('export-part001.zip')).toBe('bytes-for-https://signed/part1');
    expect(written.get('export-part002.zip')).toBe('bytes-for-https://signed/part2');
    expect(written.get('manifest.json')).toBe('bytes-for-https://signed/manifest');
    expect(written.get('hashes.txt')).toContain('export-part001.zip');
    expect(written.get('README.txt')).toContain('shasum -a 256 -c hashes.txt');
  });

  /**
   * hashes.txt names manifest.json and README.txt says the folder is
   * complete. A manifest that quietly failed to arrive leaves a folder that
   * reports success and cannot be verified — the exact shape of failure this
   * product is built to refuse.
   */
  it('fails loudly when the manifest does not arrive', async () => {
    fakePicker();
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('manifest') ? streamingResponse('', false, 403) : streamingResponse('bytes'),
      ),
    );

    await expect(saveExportToFolder(plan, () => undefined)).rejects.toThrow(/manifest\.json/);
  });

  it('fails loudly when a part does not arrive', async () => {
    fakePicker();
    vi.stubGlobal('fetch', () => Promise.resolve(streamingResponse('', false, 403)));

    await expect(saveExportToFolder(plan, () => undefined)).rejects.toThrow(/export-part001\.zip/);
  });
});

/**
 * Re-signing links mid-save.
 *
 * Presigned URLs live `CDFIR_S3_PRESIGN_TTL_SECONDS` (300). Expiry is checked
 * when a request STARTS, so one slow part is fine — but the parts are fetched in
 * order, so a part that takes over five minutes hands the NEXT one a dead URL.
 * Two 2 GiB parts on an ordinary connection does it. The save used to stop there
 * with a 403 and no way on but starting over.
 */
describe('saveExportToFolder re-signs expired links', () => {
  const REFRESH_URL =
    'https://api.aegclouddfir.com/api/v1/exports/5007e931-f4e4-481a-b273-7817aaaa1db6/download/urls';

  /** The refresh endpoint's answer, with URLs that differ from the plan's. */
  function refreshBody(): string {
    return JSON.stringify({
      manifestUrl: 'https://signed/manifest-fresh',
      parts: [
        { ...part(1), url: 'https://signed/part1-fresh' },
        { ...part(2), url: 'https://signed/part2-fresh' },
      ],
      expiresInSeconds: 300,
    });
  }

  interface Call {
    url: string;
    init?: RequestInit;
  }

  /** Records every fetch and answers 403 for the URLs named in `expired`. */
  function fetchWith(expired: Set<string>, refresh: () => Response): { calls: Call[] } {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === REFRESH_URL) return Promise.resolve(refresh());
      if (expired.has(url)) return Promise.resolve(streamingResponse('', false, 403));
      return Promise.resolve(streamingResponse(`bytes-for-${url}`));
    });
    return { calls };
  }

  const okRefresh = (): Response =>
    new Response(refreshBody(), { status: 200, headers: { 'content-type': 'application/json' } });

  it('recovers from one expired part and finishes the folder', async () => {
    const { written } = fakePicker();
    // Part 1 takes long enough that part 2's link is dead by the time it starts.
    const { calls } = fetchWith(new Set(['https://signed/part2']), okRefresh);

    await saveExportToFolder(plan, () => undefined);

    // The whole folder is there, part 2 from the re-signed URL.
    expect(written.get('export-part001.zip')).toBe('bytes-for-https://signed/part1');
    expect(written.get('export-part002.zip')).toBe('bytes-for-https://signed/part2-fresh');
    expect(written.get('manifest.json')).toBe('bytes-for-https://signed/manifest-fresh');
    expect(written.get('README.txt')).toContain('shasum -a 256 -c hashes.txt');

    // Exactly one refresh: the manifest reuses the URLs part 2 already fetched
    // rather than asking again.
    expect(calls.filter((c) => c.url === REFRESH_URL)).toHaveLength(1);
  });

  it('sends the scoped token and no cookies when it re-signs', async () => {
    /*
     * This is the call that needed the CSRF exemption on the API. It works
     * because it authenticates by the Bearer token ALONE — so it must not send
     * cookies, or the browser path would start depending on the very thing the
     * exemption assumes is absent.
     */
    fakePicker();
    const { calls } = fetchWith(new Set(['https://signed/part1']), okRefresh);

    await saveExportToFolder(plan, () => undefined);

    const refresh = calls.find((c) => c.url === REFRESH_URL);
    expect(refresh?.init?.method).toBe('POST');
    expect((refresh?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok.en');
    expect(refresh?.init?.credentials).toBe('omit');
  });

  it('fails loudly, naming the part, when the fresh link fails too', async () => {
    // Both the original and the re-signed URL are dead: the token has expired,
    // or the export has. One retry, then stop — a loop here would be a save
    // that never finishes and never says why.
    fakePicker();
    const { calls } = fetchWith(
      new Set(['https://signed/part2', 'https://signed/part2-fresh']),
      okRefresh,
    );

    await expect(saveExportToFolder(plan, () => undefined)).rejects.toThrow(
      /export-part002\.zip[\s\S]*INCOMPLETE/,
    );
    // One refresh for that part, not a stream of them.
    expect(calls.filter((c) => c.url === REFRESH_URL)).toHaveLength(1);
  });

  it('says the folder is incomplete when the refresh endpoint itself refuses', async () => {
    // A 403 from /download/urls is what a CSRF guard on that route looked like.
    // If it ever comes back, the message has to name the part and the state of
    // the folder, not just a status code.
    fakePicker();
    fetchWith(new Set(['https://signed/part1']), () => new Response('', { status: 403 }));

    await expect(saveExportToFolder(plan, () => undefined)).rejects.toThrow(
      /export-part001\.zip[\s\S]*re-signing failed[\s\S]*HTTP 403[\s\S]*INCOMPLETE/,
    );
  });

  it('does not re-sign for a failure that re-signing cannot fix', async () => {
    // 404 means the object is gone. Asking for a fresh link would hide a real
    // fault behind a retry and cost an audited disclosure for nothing.
    fakePicker();
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve(streamingResponse('', false, 404));
    });

    await expect(saveExportToFolder(plan, () => undefined)).rejects.toThrow(/HTTP 404/);
    expect(calls).not.toContain(REFRESH_URL);
  });

  it('re-signs for the manifest too, which is fetched last and expires first', async () => {
    const { written } = fakePicker();
    fetchWith(new Set(['https://signed/manifest']), okRefresh);

    await saveExportToFolder(plan, () => undefined);

    expect(written.get('manifest.json')).toBe('bytes-for-https://signed/manifest-fresh');
  });
});
