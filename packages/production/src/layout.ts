import { ProductionError } from './errors.js';
import type { FilenameScheme, ProductionImageFormat } from './types.js';

/** Standard top-level folders inside a production deliverable. */
export const PRODUCTION_FOLDERS = {
  data: 'DATA',
  images: 'IMAGES',
  natives: 'NATIVES',
  text: 'TEXT',
  manifests: 'MANIFESTS',
} as const;

/** Images per IMAGES/VOLnnn subfolder. */
export const IMAGES_PER_VOLUME = 1000;

const IMAGE_EXTENSIONS: Record<Exclude<ProductionImageFormat, 'none'>, string> = {
  tiff_g4: '.tif',
  jpeg: '.jpg',
  pdf: '.pdf',
};

/** VOL001 for images 0..999, VOL002 for 1000..1999, ... */
export function volumeLabel(
  imageIndex: number,
  imagesPerVolume: number = IMAGES_PER_VOLUME,
): string {
  if (!Number.isInteger(imageIndex) || imageIndex < 0) {
    throw new ProductionError(`imageIndex must be a non-negative integer, got ${imageIndex}`);
  }
  if (!Number.isInteger(imagesPerVolume) || imagesPerVolume < 1) {
    throw new ProductionError(`imagesPerVolume must be a positive integer, got ${imagesPerVolume}`);
  }
  const volume = Math.floor(imageIndex / imagesPerVolume) + 1;
  return `VOL${String(volume).padStart(3, '0')}`;
}

/** IMAGES/VOL001/<bates><ext> — image filename is always the page bates number. */
export function imagePath(
  batesNumber: string,
  format: Exclude<ProductionImageFormat, 'none'>,
  imageIndex: number,
  imagesPerVolume: number = IMAGES_PER_VOLUME,
): string {
  const ext = IMAGE_EXTENSIONS[format];
  return `${PRODUCTION_FOLDERS.images}/${volumeLabel(imageIndex, imagesPerVolume)}/${batesNumber}${ext}`;
}

/** TEXT/<begBates>.txt */
export function textPath(begBates: string): string {
  return `${PRODUCTION_FOLDERS.text}/${begBates}.txt`;
}

/** DATA/<fileName> — load files live here. */
export function dataPath(fileName: string): string {
  return `${PRODUCTION_FOLDERS.data}/${fileName}`;
}

/** MANIFESTS/<fileName> */
export function manifestPath(fileName: string): string {
  return `${PRODUCTION_FOLDERS.manifests}/${fileName}`;
}

function splitExtension(fileName: string): { stem: string; ext: string } {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return { stem: fileName, ext: '' };
  return { stem: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

function sanitizeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[\\/\0]/g, '_').trim();
  return cleaned.length === 0 ? 'file' : cleaned;
}

/**
 * Allocates collision-free NATIVES/ paths according to the filename scheme.
 * Collisions get an incrementing suffix before the extension: name_001.ext.
 */
export class NativeFileNameAllocator {
  private readonly scheme: FilenameScheme;
  private readonly used = new Set<string>();

  constructor(scheme: FilenameScheme) {
    this.scheme = scheme;
  }

  pathFor(input: { begBates: string; originalFileName: string }): string {
    const original = sanitizeFileName(input.originalFileName);
    const { stem, ext } = splitExtension(original);
    let base: string;
    switch (this.scheme) {
      case 'bates':
        base = `${input.begBates}${ext}`;
        break;
      case 'original':
        base = original;
        break;
      case 'bates_original':
        base = `${input.begBates}_${stem}${ext}`;
        break;
    }
    let candidate = base;
    if (this.used.has(candidate.toLowerCase())) {
      const { stem: baseStem, ext: baseExt } = splitExtension(base);
      for (let i = 1; ; i += 1) {
        candidate = `${baseStem}_${String(i).padStart(3, '0')}${baseExt}`;
        if (!this.used.has(candidate.toLowerCase())) break;
      }
    }
    this.used.add(candidate.toLowerCase());
    return `${PRODUCTION_FOLDERS.natives}/${candidate}`;
  }
}
