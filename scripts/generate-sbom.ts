#!/usr/bin/env tsx
/**
 * Generate the CycloneDX SBOM (via pnpm's native generator) and derive a
 * license report. No network access required.
 *
 * Output: sbom/sbom.cdx.json and sbom/licenses.csv
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

interface CdxLicense {
  license?: { id?: string; name?: string };
  expression?: string;
}
interface CdxComponent {
  name: string;
  version: string;
  licenses?: CdxLicense[];
}

function main(): void {
  mkdirSync('sbom', { recursive: true });
  execFileSync(
    'pnpm',
    ['sbom', '--sbom-format', 'cyclonedx', '--lockfile-only', '--out', 'sbom/sbom.cdx.json'],
    { stdio: 'inherit' },
  );

  const bom = JSON.parse(readFileSync('sbom/sbom.cdx.json', 'utf8')) as {
    components?: CdxComponent[];
  };
  const components = bom.components ?? [];

  const rows = ['name,version,license'];
  for (const c of components) {
    const license =
      (c.licenses ?? [])
        .map((l) => l.license?.id ?? l.license?.name ?? l.expression ?? '')
        .filter(Boolean)
        .join('; ') || 'UNKNOWN';
    rows.push(
      [c.name, c.version, license].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','),
    );
  }
  writeFileSync('sbom/licenses.csv', rows.join('\n') + '\n');

  console.log(`SBOM: sbom/sbom.cdx.json (${components.length} components)`);
  console.log(`License report: sbom/licenses.csv`);

  const flagged = rows.filter((r) => /GPL-3|AGPL|SSPL|UNLICENSED/i.test(r) && !/LGPL/i.test(r));
  if (flagged.length > 0) {
    console.error(`⚠ review ${flagged.length} strong-copyleft/unlicensed entries:`);
    for (const r of flagged.slice(0, 10)) console.error(`  ${r}`);
    process.exitCode = 2;
  }
}

main();
