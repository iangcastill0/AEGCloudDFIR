import { describe, expect, it } from 'vitest';
import { ProductionError } from './errors.js';
import {
  IMAGES_PER_VOLUME,
  NativeFileNameAllocator,
  PRODUCTION_FOLDERS,
  dataPath,
  imagePath,
  manifestPath,
  textPath,
  volumeLabel,
} from './layout.js';

describe('folder layout', () => {
  it('exposes the standard folder names', () => {
    expect(PRODUCTION_FOLDERS).toEqual({
      data: 'DATA',
      images: 'IMAGES',
      natives: 'NATIVES',
      text: 'TEXT',
      manifests: 'MANIFESTS',
    });
    expect(IMAGES_PER_VOLUME).toBe(1000);
  });

  it('rolls image volumes every 1000 images', () => {
    expect(volumeLabel(0)).toBe('VOL001');
    expect(volumeLabel(999)).toBe('VOL001');
    expect(volumeLabel(1000)).toBe('VOL002');
    expect(volumeLabel(2500)).toBe('VOL003');
    expect(volumeLabel(0, 10)).toBe('VOL001');
    expect(volumeLabel(10, 10)).toBe('VOL002');
    expect(() => volumeLabel(-1)).toThrow(ProductionError);
    expect(() => volumeLabel(0, 0)).toThrow(ProductionError);
  });

  it('builds image paths named by bates number with format extensions', () => {
    expect(imagePath('ABC00000001', 'tiff_g4', 0)).toBe('IMAGES/VOL001/ABC00000001.tif');
    expect(imagePath('ABC00001001', 'jpeg', 1000)).toBe('IMAGES/VOL002/ABC00001001.jpg');
    expect(imagePath('ABC00000009', 'pdf', 8)).toBe('IMAGES/VOL001/ABC00000009.pdf');
  });

  it('builds text, data, and manifest paths', () => {
    expect(textPath('ABC00000001')).toBe('TEXT/ABC00000001.txt');
    expect(dataPath('production.dat')).toBe('DATA/production.dat');
    expect(manifestPath('manifest.json')).toBe('MANIFESTS/manifest.json');
  });
});

describe('NativeFileNameAllocator', () => {
  it('scheme bates: bates number plus the original extension', () => {
    const alloc = new NativeFileNameAllocator('bates');
    expect(alloc.pathFor({ begBates: 'ABC00000001', originalFileName: 'report.XLSX' })).toBe(
      'NATIVES/ABC00000001.XLSX',
    );
    expect(alloc.pathFor({ begBates: 'ABC00000002', originalFileName: 'noext' })).toBe(
      'NATIVES/ABC00000002',
    );
  });

  it('scheme original: keeps the original name and suffixes collisions', () => {
    const alloc = new NativeFileNameAllocator('original');
    expect(alloc.pathFor({ begBates: 'A1', originalFileName: 'report.xlsx' })).toBe(
      'NATIVES/report.xlsx',
    );
    expect(alloc.pathFor({ begBates: 'A2', originalFileName: 'report.xlsx' })).toBe(
      'NATIVES/report_001.xlsx',
    );
    expect(alloc.pathFor({ begBates: 'A3', originalFileName: 'report.xlsx' })).toBe(
      'NATIVES/report_002.xlsx',
    );
  });

  it('scheme bates_original combines both', () => {
    const alloc = new NativeFileNameAllocator('bates_original');
    expect(alloc.pathFor({ begBates: 'ABC00000001', originalFileName: 'deal memo.docx' })).toBe(
      'NATIVES/ABC00000001_deal memo.docx',
    );
  });

  it('sanitizes path separators and detects collisions case-insensitively', () => {
    const alloc = new NativeFileNameAllocator('original');
    expect(alloc.pathFor({ begBates: 'A1', originalFileName: '../../etc/passwd' })).toBe(
      'NATIVES/.._.._etc_passwd',
    );
    expect(alloc.pathFor({ begBates: 'A2', originalFileName: 'Report.PDF' })).toBe(
      'NATIVES/Report.PDF',
    );
    expect(alloc.pathFor({ begBates: 'A3', originalFileName: 'report.pdf' })).toBe(
      'NATIVES/report_001.pdf',
    );
  });
});
