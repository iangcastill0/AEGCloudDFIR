#!/usr/bin/env tsx
/**
 * Generate a CycloneDX-style SBOM and a license report from the pnpm
 * lockfile, without network access.
 *
 * Output: sbom/sbom.cdx.json and sbom/licenses.csv
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

interface PnpmLicensePkg {
  name: string;
  versions?: string[];
  version?: string;
  license: string;
  author?: string;
  homepage?: string;
}

function main(): void {
  mkdirSync('sbom', { recursive: true });

  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--long'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicense = JSON.parse(raw) as Record<string, PnpmLicensePkg[]>;

  const components: object[] = [];
  const csvLines = ['name,version,license,homepage'];
  for (const [license, pkgs] of Object.entries(byLicense)) {
    for (const pkg of pkgs) {
      const versions = pkg.versions ?? (pkg.version ? [pkg.version] : []);
      for (const version of versions) {
        components.push({
          type: 'library',
          'bom-ref': `pkg:npm/${pkg.name}@${version}`,
          name: pkg.name,
          version,
          purl: `pkg:npm/${pkg.name}@${version}`,
          licenses: [{ license: { name: license } }],
          ...(pkg.homepage ? { externalReferences: [{ type: 'website', url: pkg.homepage }] } : {}),
        });
        csvLines.push(
          [pkg.name, version, license, pkg.homepage ?? '']
            .map((v) => `"${String(v).replaceAll('"', '""')}"`)
            .join(','),
        );
      }
    }
  }

  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(0, 32)}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: 'application', name: 'evidencevault', version: '0.1.0' },
    },
    components,
  };

  writeFileSync('sbom/sbom.cdx.json', JSON.stringify(bom, null, 2));
  writeFileSync('sbom/licenses.csv', csvLines.join('\n') + '\n');
  console.log(`SBOM written: sbom/sbom.cdx.json (${components.length} components)`);
  console.log('License report: sbom/licenses.csv');

  const problematic = Object.keys(byLicense).filter((l) =>
    /GPL-3|AGPL|SSPL|proprietary|UNLICENSED/i.test(l),
  );
  if (problematic.length > 0) {
    console.error(`⚠ review licenses: ${problematic.join(', ')}`);
  }
}

main();
