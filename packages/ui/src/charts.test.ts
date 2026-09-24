import { describe, expect, it } from 'vitest';
import {
  areaLabel,
  areaPath,
  bandRect,
  groupDigits,
  idleStripes,
  niceMax,
  phaseBarLabel,
  phaseSegments,
  polylinePoints,
  scaleSeries,
  shortBytes,
  shortDuration,
  sparklineLabel,
  type ChartBox,
} from './charts.js';

const BOX: ChartBox = { width: 100, height: 100 };

describe('groupDigits — evidence figures read the same everywhere', () => {
  it('groups thousands without Intl, so CI locale cannot change the answer', () => {
    expect(groupDigits(434910)).toBe('434,910');
    expect(groupDigits(185379)).toBe('185,379');
    expect(groupDigits(1140)).toBe('1,140');
    expect(groupDigits(54)).toBe('54');
    expect(groupDigits(0)).toBe('0');
  });
});

describe('scaleSeries — two axes, because the two series are unrelated', () => {
  it('puts the maximum at the top and zero at the bottom', () => {
    const points = scaleSeries([0, 50, 100], BOX, 100);
    expect(points[0]?.y).toBe(100);
    expect(points[1]?.y).toBe(50);
    expect(points[2]?.y).toBe(0);
  });

  it('spreads points across the full width', () => {
    const points = scaleSeries([1, 2, 3], BOX, 3);
    expect(points[0]?.x).toBe(0);
    expect(points[2]?.x).toBe(100);
  });

  it('centres a single point rather than pinning it to the left edge', () => {
    expect(scaleSeries([7], BOX, 10)[0]?.x).toBe(50);
  });

  it('clamps a value above the axis instead of drawing outside the box', () => {
    expect(scaleSeries([200], BOX, 100)[0]?.y).toBe(0);
  });

  it('survives an all-zero series without dividing by zero', () => {
    const points = scaleSeries([0, 0], BOX, 0);
    expect(points.every((p) => Number.isFinite(p.y))).toBe(true);
  });

  it('scales the same values differently on a different axis max', () => {
    // The point of two axes: items/min and bytes/min have nothing to do with
    // each other (measured correlation -0.143), so one shared scale would flatten
    // whichever series has the smaller numbers onto the floor.
    const onItemsAxis = scaleSeries([100], BOX, 200)[0]?.y;
    const onBytesAxis = scaleSeries([100], BOX, 100)[0]?.y;
    expect(onItemsAxis).not.toBe(onBytesAxis);
  });
});

describe('bandRect — this run\u2019s own normal', () => {
  it('spans p10 to p90 on the items axis', () => {
    // The real run: p10 54, p90 162, peak 1,140.
    const band = bandRect(54, 162, { width: 100, height: 200 }, 1140);
    expect(band).not.toBeNull();
    // Top of the band is p90, so a smaller y than the bottom.
    expect(band?.y).toBeCloseTo(200 - (162 / 1140) * 200, 5);
    expect(band?.height).toBeCloseTo(((162 - 54) / 1140) * 200, 5);
  });

  it('is absent while the percentiles are unmeasured', () => {
    expect(bandRect(null, null, BOX, 100)).toBeNull();
    expect(bandRect(54, null, BOX, 100)).toBeNull();
  });

  it('stays at least one unit tall so a narrow band is still visible', () => {
    const band = bandRect(50, 50, BOX, 100);
    expect(band?.height).toBeGreaterThanOrEqual(1);
  });

  it('tolerates reversed percentiles', () => {
    expect(bandRect(162, 54, BOX, 1000)?.height).toBeCloseTo(
      bandRect(54, 162, BOX, 1000)?.height ?? -1,
      5,
    );
  });
});

describe('idleStripes — a gap must be drawn, not closed up', () => {
  it('returns one stripe per idle bucket, at that bucket\u2019s position', () => {
    const stripes = idleStripes([false, true, false, true], { width: 100, height: 10 });
    expect(stripes).toHaveLength(2);
    expect(stripes[0]?.x).toBe(25);
    expect(stripes[1]?.x).toBe(75);
    expect(stripes[0]?.width).toBe(25);
  });

  it('returns nothing when every bucket acquired something', () => {
    expect(idleStripes([false, false], BOX)).toHaveLength(0);
  });

  it('handles an empty run', () => {
    expect(idleStripes([], BOX)).toHaveLength(0);
  });
});

describe('areaPath — cumulative bytes, never extended forward', () => {
  it('closes the path at the last real point and nowhere further right', () => {
    const points = scaleSeries([1, 2, 3], BOX, 3);
    const path = areaPath(points, BOX);
    // Opens and closes on the baseline at the first and last measured x.
    expect(path.startsWith('M 0.0 100')).toBe(true);
    expect(path.endsWith('L 100.0 100 Z')).toBe(true);
    // 100 is the last measured x AND the box width, so there is no segment
    // beyond the data. Anything past it would be a forecast.
    expect(path).not.toContain('L 120');
  });

  it('draws nothing for no data', () => {
    expect(areaPath([], BOX)).toBe('');
  });
});

describe('niceMax', () => {
  it('rounds an axis up to something a person can read', () => {
    expect(niceMax(1140)).toBe(2000);
    expect(niceMax(162)).toBe(200);
    expect(niceMax(54)).toBe(100);
    expect(niceMax(100)).toBe(100);
  });

  it('never returns zero, so nothing divides by it', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
  });
});

describe('phaseSegments — the picture that makes the 27-hour tail visible', () => {
  const zero = {
    discovered: 0,
    fetching: 0,
    preserved: 0,
    processed: 0,
    indexed: 0,
    failed: 0,
    skipped: 0,
  };

  it('shows a fully acquired, still-processing collection as mostly preserved', () => {
    // This is the state that used to look identical to "stuck": every byte is
    // here, and 29% of the run is still ahead in parse/extract/OCR/index.
    const segments = phaseSegments({ ...zero, preserved: 300000, processed: 0, indexed: 134910 });
    const preserved = segments.find((s) => s.key === 'preserved');
    const done = segments.find((s) => s.key === 'done');
    expect(preserved?.count).toBe(300000);
    expect(done?.count).toBe(134910);
    expect(segments.find((s) => s.key === 'fetching')).toBeUndefined();
  });

  it('merges processed and indexed into one "done" segment', () => {
    const segments = phaseSegments({ ...zero, processed: 40, indexed: 60 });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.key).toBe('done');
    expect(segments[0]?.count).toBe(100);
    expect(segments[0]?.percent).toBe(100);
  });

  it('drops zero-count states: a 0%-wide flex child still paints a border', () => {
    const segments = phaseSegments({ ...zero, indexed: 10 });
    expect(segments.map((s) => s.key)).toEqual(['done']);
  });

  it('percentages sum to 100 across a mixed collection', () => {
    const segments = phaseSegments({
      discovered: 11,
      fetching: 3,
      preserved: 17,
      processed: 5,
      indexed: 60,
      failed: 2,
      skipped: 2,
    });
    const sum = segments.reduce((n, s) => n + s.percent, 0);
    expect(sum).toBeCloseTo(100, 6);
  });

  it('returns nothing before anything is discovered', () => {
    expect(phaseSegments(zero)).toHaveLength(0);
  });

  it('keeps failures visible even when they are a rounding error of the whole', () => {
    // 1 failure in 434,910 is 0.0002%. It must still be a segment, because it is
    // the only thing on this bar that means evidence is missing.
    const segments = phaseSegments({ ...zero, indexed: 434909, failed: 1 });
    expect(segments.find((s) => s.key === 'failed')?.count).toBe(1);
  });
});

describe('accessible names state the numbers, not the shape', () => {
  const base = {
    windowName: 'last 60 minutes, one bucket per minute',
    items: 4812,
    bytes: 1024 * 1024 * 1024,
    itemsPerMinute: 80,
    bytesPerMinute: 1024 * 1024,
    p10ItemsPerMinute: 54,
    p90ItemsPerMinute: 162,
    peakItemsPerMinute: 1140,
    idleBuckets: 12,
  };

  it('carries counts, pace, the run\u2019s own band and the idle count', () => {
    const label = sparklineLabel(base);
    expect(label).toContain('4,812 items');
    expect(label).toContain('80 items per minute');
    expect(label).toContain('54 to 162 items');
    expect(label).toContain('busiest minute 1,140 items');
    expect(label).toContain('12 buckets acquired nothing');
  });

  it('never describes the drawing', () => {
    const label = sparklineLabel(base).toLowerCase();
    for (const shapeWord of ['line', 'curve', 'rising', 'falling', 'trend', 'chart', 'graph']) {
      expect(label).not.toContain(shapeWord);
    }
  });

  it('says the pace is unmeasured rather than printing zero', () => {
    // A "0 per minute" on screen reads as stalled, and calling a 30-second-old
    // collection stalled is the false alarm that trains people to ignore alarms.
    const label = sparklineLabel({ ...base, itemsPerMinute: null, bytesPerMinute: null });
    expect(label).toContain('pace not measured yet');
    expect(label).not.toMatch(/\b0 items per minute\b/);
  });

  it('singularises one idle bucket', () => {
    expect(sparklineLabel({ ...base, idleBuckets: 1 })).toContain('1 bucket acquired nothing');
  });

  it('the area chart admits the total is unknown instead of implying one', () => {
    const label = areaLabel({ windowName: 'whole run', cumulativeBytes: 130 * 1024 ** 3 });
    expect(label).toContain('130 GB preserved so far');
    expect(label).toContain('not yet known');
  });

  it('the phase bar names and counts every segment', () => {
    const segments = phaseSegments({
      discovered: 0,
      fetching: 0,
      preserved: 300000,
      processed: 0,
      indexed: 134910,
      failed: 0,
      skipped: 0,
    });
    const label = phaseBarLabel(segments, 434910);
    expect(label).toContain('out of 434,910 items');
    expect(label).toContain('Preserved, awaiting processing 300,000');
    expect(label).toContain('Processed and indexed 134,910');
  });

  it('the phase bar says so when there is nothing yet', () => {
    expect(phaseBarLabel([], 0)).toContain('nothing discovered yet');
  });
});

describe('shortBytes / shortDuration', () => {
  it('formats the real run\u2019s size and item sizes', () => {
    // Two significant-ish figures below 10, whole numbers above: 130 GB reads
    // better than 130.0 GB, and 3.1 MB better than 3 MB.
    expect(shortBytes(130 * 1024 ** 3)).toBe('130 GB');
    expect(shortBytes(3188 * 1024)).toBe('3.1 MB');
    expect(shortBytes(21 * 1024)).toBe('21 KB');
    expect(shortBytes(672 * 1024 ** 2)).toBe('672 MB');
    expect(shortBytes(0)).toBe('0 B');
  });

  it('formats elapsed time as elapsed, never as remaining', () => {
    // 93.22 h and 66.00 h, the two real wall clocks.
    expect(shortDuration(93.22 * 3600_000)).toBe('3 d 21 h 13 m');
    expect(shortDuration(66 * 3600_000)).toBe('2 d 18 h');
    expect(shortDuration(0)).toBe('0 m');
  });
});

describe('polylinePoints', () => {
  it('emits an SVG points list', () => {
    expect(
      polylinePoints([
        { x: 0, y: 1.25 },
        { x: 10, y: 0 },
      ]),
    ).toBe('0.0,1.3 10.0,0.0');
  });
});
