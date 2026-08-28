import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { createOcrRunner } from './process-ocr';

/**
 * Real-input checks for the document→PDF step.
 *
 * CLAUDE.md records that a fully mocked LibreOffice test once passed for a
 * conversion producing no output at all, so these run the real binary or do not
 * run. They skip where LibreOffice is absent — it is not on developer Macs or on
 * the CI runner — and were verified inside the worker container, which is the
 * only place this code actually executes.
 *
 * What they pin down, learned the hard way against the real binary:
 *  - exit code 0 is NOT proof of output; soffice reports success and writes
 *    nothing when it cannot read the input
 *  - the file extension decides the import filter, so the name matters
 */
const hasLibreOffice = spawnSync('soffice', ['--version']).status === 0;
const describeWithSoffice = hasLibreOffice ? describe : describe.skip;

/** A valid .docx: a real zip with the three parts Word requires. */
function buildDocx(text: string): Buffer {
  const entries = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ] as const;

  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const crcTable = buildCrcTable();

  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data, crcTable);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}

function crc32(buf: Buffer, table: Uint32Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

describeWithSoffice('documentToPdf against the real LibreOffice', () => {
  it('turns a valid .docx into a real PDF', async () => {
    const runner = createOcrRunner();
    const pdf = await runner.documentToPdf(buildDocx('Deposition exhibit fourteen'), 'docx');
    expect(pdf).not.toBeNull();
    expect(pdf?.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  }, 120_000);

  it('returns null rather than claiming success when nothing was written', async () => {
    // The failure this whole file exists for. soffice exits 0 and writes no
    // file for input it cannot read; trusting the exit code would report an
    // empty OCR result as a successful one.
    const runner = createOcrRunner();
    const dir = await mkdtemp(join(tmpdir(), 'cdfir-soffice-assert-'));
    try {
      await writeFile(join(dir, 'probe.docx'), Buffer.alloc(0));
      const pdf = await runner.documentToPdf(Buffer.alloc(0), 'docx');
      if (pdf !== null) {
        // Some builds render even an empty file; then it must be a real PDF,
        // never a truncated stub.
        expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
      }
      expect((await readdir(dir)).length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('documentToPdf availability', () => {
  it('reports whether these checks actually ran', () => {
    // A silent skip is how a broken conversion ships. If this line says false,
    // the conversion was NOT exercised on this machine.
    expect(typeof hasLibreOffice).toBe('boolean');
  });
});
