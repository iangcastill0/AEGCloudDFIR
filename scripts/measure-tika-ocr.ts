#!/usr/bin/env tsx
/**
 * Measure what Tika's built-in OCR costs, and what it contributes.
 *
 *   tsx scripts/measure-tika-ocr.ts --a http://tika:9998 --b http://tika-staging:9998
 *   tsx scripts/measure-tika-ocr.ts --per-type 40 --types image/png,application/pdf
 *
 * Read-only: it fetches real evidence bytes and sends them to two Tika servers.
 * Nothing is written to the database, the queues or object storage.
 *
 * A is the control (production's `-full` image, Tesseract bundled and active).
 * B is the candidate (same image, a config excluding TesseractOCRParser).
 *
 * Reading the result
 * ------------------
 * For `image/*` and `application/pdf`, ocr-policy.ts queues the dedicated OCR
 * stage unconditionally, so characters Tika loses are recovered there. Time
 * saved in Tika is a real saving; characters lost are not a real loss.
 *
 * For the CONVERTIBLE_DOCUMENTS set, the decision is `extractedChars <
 * LOW_TEXT_THRESHOLD` (40). An item that A puts above 40 and B puts below it
 * changes behaviour: it gains a LibreOffice convert-and-rasterise, which is
 * slower than the Tika OCR it replaced. Those are the items to count, and the
 * report names them.
 */
import { loadConfig } from '@aeg-clouddfir/config';
import { createPrismaClient, withTenantContext } from '@aeg-clouddfir/database';

const LOW_TEXT_THRESHOLD = 40;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

/** Office types where Tika's OCR can change the OCR decision. */
const CONVERTIBLE = /word|excel|powerpoint|opendocument|rtf/;

interface Row {
  mime: string;
  msA: number;
  msB: number;
  charsA: number;
  charsB: number;
}

async function tika(url: string, bytes: Buffer, mime: string): Promise<[number, number]> {
  const started = Date.now();
  const res = await fetch(`${url.replace(/\/$/, '')}/tika`, {
    method: 'PUT',
    headers: { Accept: 'text/plain', 'Content-Type': mime },
    body: new Uint8Array(bytes),
  });
  const text = res.ok ? await res.text() : '';
  return [Date.now() - started, text.trim().length];
}

const median = (xs: number[]): number =>
  xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function main(): Promise<void> {
  const urlA = arg('a', 'http://tika:9998');
  const urlB = arg('b', 'http://tika-staging:9998');
  const perType = Number(arg('per-type', '20'));
  const types = arg(
    'types',
    'image/png,image/jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ).split(',');

  const config = loadConfig();
  const prisma = createPrismaClient(config.CDFIR_DATABASE_URL);

  // Imported at runtime rather than statically: the S3 SDK is a dependency of
  // packages/evidence, not of the root, so a static import does not resolve from
  // scripts/. This script only ever runs inside the worker container, which has
  // it. Typed narrowly here rather than pulling the package into the root.
  // The specifier is a variable on purpose: TypeScript resolves a literal one
  // even in a dynamic import, and this package is a dependency of
  // packages/evidence rather than of the root.
  const sdkName = '@aws-sdk/client-s3';
  const { S3Client, GetObjectCommand } = (await import(sdkName)) as {
    S3Client: new (o: unknown) => {
      send: (c: unknown) => Promise<{ Body: { transformToByteArray: () => Promise<Uint8Array> } }>;
    };
    GetObjectCommand: new (o: { Bucket: string; Key: string }) => unknown;
  };

  const s3 = new S3Client({
    endpoint: config.CDFIR_S3_ENDPOINT,
    region: config.CDFIR_S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.CDFIR_S3_ACCESS_KEY_ID,
      secretAccessKey: config.CDFIR_S3_SECRET_ACCESS_KEY,
    },
  });

  const tenants = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform', 'true', true)`;
    return tx.tenant.findMany({ select: { id: true } });
  });

  console.log(`A (control, OCR on):  ${urlA}`);
  console.log(`B (candidate, OCR off): ${urlB}`);
  console.log(`sampling up to ${String(perType)} items per type\n`);

  const rows: Row[] = [];

  for (const { id: tenantId } of tenants) {
    for (const mime of types) {
      const items = await withTenantContext(prisma, tenantId, (tx) =>
        tx.evidenceItem.findMany({
          where: { mimeType: mime, blobId: { not: null } },
          select: { id: true, mimeType: true, blob: { select: { objectKey: true } } },
          take: perType,
          orderBy: { id: 'asc' },
        }),
      );
      for (const item of items) {
        const key = item.blob?.objectKey;
        if (key === undefined) continue;
        let bytes: Buffer;
        try {
          const obj = await s3.send(
            new GetObjectCommand({ Bucket: config.CDFIR_S3_BUCKET_EVIDENCE, Key: key }),
          );
          bytes = Buffer.from(await obj.Body.transformToByteArray());
        } catch {
          continue; // a missing object is not what this is measuring
        }
        try {
          const [msA, charsA] = await tika(urlA, bytes, mime);
          const [msB, charsB] = await tika(urlB, bytes, mime);
          rows.push({ mime, msA, msB, charsA, charsB });
          process.stdout.write('.');
        } catch {
          process.stdout.write('x');
        }
      }
    }
  }
  console.log('\n');

  for (const mime of types) {
    const r = rows.filter((x) => x.mime === mime);
    if (r.length === 0) {
      console.log(`${mime}\n  no samples\n`);
      continue;
    }
    const mA = median(r.map((x) => x.msA));
    const mB = median(r.map((x) => x.msB));
    const totalA = r.reduce((a, x) => a + x.msA, 0);
    const totalB = r.reduce((a, x) => a + x.msB, 0);
    const lostText = r.filter((x) => x.charsB < x.charsA).length;

    console.log(`${mime}   (${String(r.length)} samples)`);
    console.log(
      `  median per item   A ${String(mA).padStart(6)} ms    B ${String(mB).padStart(6)} ms` +
        `    ${mA > 0 ? `${(mA / Math.max(mB, 1)).toFixed(1)}x faster` : ''}`,
    );
    console.log(
      `  total for sample  A ${String(totalA).padStart(6)} ms    B ${String(totalB).padStart(6)} ms` +
        `    saves ${String(totalA - totalB)} ms`,
    );
    console.log(`  items where B returned less text: ${String(lostText)} of ${String(r.length)}`);

    if (CONVERTIBLE.test(mime)) {
      const flipped = r.filter(
        (x) => x.charsA >= LOW_TEXT_THRESHOLD && x.charsB < LOW_TEXT_THRESHOLD,
      ).length;
      console.log(
        `  *** crosses the ${String(LOW_TEXT_THRESHOLD)}-char threshold (gains a convert+rasterise): ` +
          `${String(flipped)} of ${String(r.length)}`,
      );
    } else {
      console.log('  (image/pdf: the OCR stage runs regardless, so lost text is recovered there)');
    }
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
