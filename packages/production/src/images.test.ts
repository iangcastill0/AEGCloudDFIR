import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ProductionError } from './errors.js';
import { toJpeg, toTiffG4 } from './images.js';

async function makePng(): Promise<Buffer> {
  const box = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">' +
      '<rect x="20" y="20" width="80" height="40" fill="#000000"/></svg>',
  );
  return sharp({ create: { width: 200, height: 120, channels: 3, background: '#ffffff' } })
    .composite([{ input: box }])
    .png()
    .toBuffer();
}

/** TIFF tag 259 (Compression), type SHORT, count 1, value 4 = CCITT Group 4 — little-endian. */
const G4_COMPRESSION_TAG = Buffer.from([
  0x03, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x00,
]);

describe('toTiffG4', () => {
  it('outputs a little-endian TIFF (II*\\0 magic)', async () => {
    const tif = await toTiffG4(await makePng());
    expect(tif.subarray(0, 4)).toEqual(Buffer.from([0x49, 0x49, 0x2a, 0x00]));
  });

  it('is 1-bit single-channel with Group 4 compression and the requested dpi', async () => {
    const tif = await toTiffG4(await makePng(), { dpi: 300 });
    const meta = await sharp(tif).metadata();
    expect(meta.format).toBe('tiff');
    expect(meta.bitsPerSample).toBe(1);
    expect(meta.channels).toBe(1);
    expect(meta.density).toBe(300);
    expect(tif.includes(G4_COMPRESSION_TAG)).toBe(true);
  });

  it('survives a decode round-trip with bilevel pixels intact', async () => {
    const tif = await toTiffG4(await makePng(), { dpi: 200 });
    const { data, info } = await sharp(tif).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(200);
    expect(info.height).toBe(120);
    const px = (x: number, y: number): number => data[(y * info.width + x) * info.channels] ?? -1;
    expect(px(50, 40)).toBe(0); // inside the black box
    expect(px(150, 100)).toBe(255); // background
    // Strictly bilevel after threshold.
    const unique = new Set<number>();
    for (let i = 0; i < data.length; i += info.channels) unique.add(data[i] ?? -1);
    expect([...unique].every((v) => v === 0 || v === 255)).toBe(true);
  });

  it('validates dpi and threshold', async () => {
    const png = await makePng();
    await expect(toTiffG4(png, { dpi: 0 })).rejects.toThrow(ProductionError);
    await expect(toTiffG4(png, { threshold: 0 })).rejects.toThrow(ProductionError);
    await expect(toTiffG4(png, { threshold: 256 })).rejects.toThrow(ProductionError);
  });
});

describe('toJpeg', () => {
  it('outputs a JPEG (FFD8 magic) that decodes to the same dimensions', async () => {
    const jpeg = await toJpeg(await makePng());
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(120);
  });

  it('validates quality', async () => {
    await expect(toJpeg(await makePng(), { quality: 0 })).rejects.toThrow(ProductionError);
    await expect(toJpeg(await makePng(), { quality: 101 })).rejects.toThrow(ProductionError);
  });
});
