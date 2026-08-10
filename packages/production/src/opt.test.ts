import { describe, expect, it } from 'vitest';
import { buildOptFile } from './opt.js';
import { imagePath, volumeLabel } from './layout.js';
import { ProductionError } from './errors.js';

describe('buildOptFile', () => {
  it('emits the exact multi-doc multi-page format with CRLF, doc breaks, and page counts', () => {
    const opt = buildOptFile(
      [
        {
          pages: [
            { batesNumber: 'ABC00000001', imagePath: 'IMAGES/VOL001/ABC00000001.tif' },
            { batesNumber: 'ABC00000002', imagePath: 'IMAGES/VOL001/ABC00000002.tif' },
            { batesNumber: 'ABC00000003', imagePath: 'IMAGES/VOL001/ABC00000003.tif' },
          ],
        },
        {
          pages: [{ batesNumber: 'ABC00000004', imagePath: 'IMAGES/VOL001/ABC00000004.tif' }],
        },
      ],
      'VOL001',
    );
    expect(opt).toBe(
      'ABC00000001,VOL001,IMAGES/VOL001/ABC00000001.tif,Y,,,3\r\n' +
        'ABC00000002,VOL001,IMAGES/VOL001/ABC00000002.tif,,,,\r\n' +
        'ABC00000003,VOL001,IMAGES/VOL001/ABC00000003.tif,,,,\r\n' +
        'ABC00000004,VOL001,IMAGES/VOL001/ABC00000004.tif,Y,,,1\r\n',
    );
  });

  it('supports per-page volume labels for volume subfoldering rollover', () => {
    // Simulate a 2-page document straddling the 1000-image volume boundary.
    const doc = {
      pages: [999, 1000].map((imageIndex) => {
        const bates = `ABC${String(imageIndex + 1).padStart(8, '0')}`;
        return {
          batesNumber: bates,
          imagePath: imagePath(bates, 'tiff_g4', imageIndex),
          volumeLabel: volumeLabel(imageIndex),
        };
      }),
    };
    const opt = buildOptFile([doc], 'VOL001');
    expect(opt).toBe(
      'ABC00001000,VOL001,IMAGES/VOL001/ABC00001000.tif,Y,,,2\r\n' +
        'ABC00001001,VOL002,IMAGES/VOL002/ABC00001001.tif,,,,\r\n',
    );
  });

  it('rejects empty documents and fields containing delimiters', () => {
    expect(() => buildOptFile([{ pages: [] }], 'VOL001')).toThrow(ProductionError);
    expect(() =>
      buildOptFile(
        [{ pages: [{ batesNumber: 'A,B', imagePath: 'IMAGES/VOL001/AB.tif' }] }],
        'VOL001',
      ),
    ).toThrow(ProductionError);
  });

  it('returns an empty string for zero documents', () => {
    expect(buildOptFile([], 'VOL001')).toBe('');
  });
});
