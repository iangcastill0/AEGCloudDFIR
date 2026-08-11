import sharp from 'sharp';
import { ProductionError } from './errors.js';

export interface TiffG4Options {
  /** Output resolution in dots per inch. Default 300. */
  dpi?: number;
  /** Bilevel threshold 0..255 applied before 1-bit conversion. Default 128. */
  threshold?: number;
}

const MM_PER_INCH = 25.4;

/**
 * Convert a rasterized page image (PNG/JPEG buffer) to a single-page,
 * 1-bit CCITT Group 4 compressed TIFF — the standard litigation image format.
 */
export async function toTiffG4(
  image: Buffer | Uint8Array,
  options: TiffG4Options = {},
): Promise<Buffer> {
  const dpi = options.dpi ?? 300;
  const threshold = options.threshold ?? 128;
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new ProductionError(`dpi must be positive, got ${dpi}`);
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 255) {
    throw new ProductionError(`threshold must be an integer 1..255, got ${threshold}`);
  }
  return sharp(image)
    .flatten({ background: '#ffffff' })
    .threshold(threshold)
    .toColourspace('b-w')
    .tiff({
      compression: 'ccittfax4',
      bitdepth: 1,
      xres: dpi / MM_PER_INCH,
      yres: dpi / MM_PER_INCH,
      resolutionUnit: 'inch',
    })
    .toBuffer();
}

export interface JpegOptions {
  /** JPEG quality 1..100. Default 85. */
  quality?: number;
}

/** Convert a rasterized page image to a flattened JPEG. */
export async function toJpeg(
  image: Buffer | Uint8Array,
  options: JpegOptions = {},
): Promise<Buffer> {
  const quality = options.quality ?? 85;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new ProductionError(`quality must be an integer 1..100, got ${quality}`);
  }
  return sharp(image).flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
}
