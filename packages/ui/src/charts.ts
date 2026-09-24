/**
 * Geometry and wording for the throughput charts.
 *
 * Hand-rolled on purpose. apps/web has six runtime dependencies and a charting
 * library would be the seventh for three small pictures; recharts alone is
 * larger than everything we draw. Everything here is pure arithmetic and
 * strings, so it is tested directly rather than through a DOM.
 *
 * The strings matter as much as the numbers. This repo treats a chart that only
 * works if you can see it as a defect, so every component below is built from an
 * `aria-label` that states the FIGURES — "80 items per minute" — never the shape
 * ("a line trending upwards"). A screen-reader user gets the same facts.
 */

/** A point in SVG user units, y already flipped so 0 is the bottom. */
export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartBox {
  width: number;
  height: number;
}

/**
 * Digit grouping without Intl.
 *
 * Intl formats by the machine's locale, so a test asserting "434,910" passes on
 * one CI runner and fails on another. These are evidence figures; they read the
 * same everywhere.
 */
export function groupDigits(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  const digits = String(rounded);
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return sign + out;
}

/** Bytes as a short human string. Binary units, matching the rest of the app. */
export function shortBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value >= 10 ? String(Math.round(value)) : value.toFixed(1)} ${unit}`;
}

/**
 * Map a series onto the box.
 *
 * `max` is passed in rather than taken from the series because the two lines
 * have their own axes: items per minute on the left, bytes per minute on the
 * right. Sharing one scale would flatten whichever series has the smaller
 * numbers into the floor, and on the real run items/sec and bytes/sec correlate
 * at -0.143 — they are genuinely unrelated, so they need separate axes.
 */
export function scaleSeries(values: number[], box: ChartBox, max: number): ChartPoint[] {
  if (values.length === 0) return [];
  const safeMax = max > 0 ? max : 1;
  const step = values.length === 1 ? 0 : box.width / (values.length - 1);
  return values.map((value, index) => ({
    x: values.length === 1 ? box.width / 2 : index * step,
    y: box.height - Math.min(Math.max(value, 0), safeMax) * (box.height / safeMax),
  }));
}

/** `points` attribute for an SVG polyline, rounded so the markup stays small. */
export function polylinePoints(points: ChartPoint[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/**
 * Closed path for a filled area under a line.
 *
 * Used for cumulative bytes, and never extended past the last real point: the
 * total is unknowable while a run is going, because 249,531 of the real run's
 * 434,910 items were attachments that `parse` created after their parent. An
 * area that kept rising to a guessed total would be a forecast wearing a
 * measurement's clothes.
 */
export function areaPath(points: ChartPoint[], box: ChartBox): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return '';
  const line = points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ');
  return `M ${first.x.toFixed(1)} ${String(box.height)} L ${line} L ${last.x.toFixed(1)} ${String(box.height)} Z`;
}

/**
 * The pale band behind the lines, at this run's own p10 and p90.
 *
 * This is the whole reason the chart beats a number: it answers "is this minute
 * normal for THIS job?" without anyone knowing what normal is. The real run's
 * band was 54 to 162 items per minute, with a p99 of 384 and one minute at
 * 1,140 — against a fixed threshold most of its healthy minutes would have
 * looked alarming.
 */
export function bandRect(
  p10: number | null,
  p90: number | null,
  box: ChartBox,
  max: number,
): { y: number; height: number } | null {
  if (p10 === null || p90 === null || max <= 0) return null;
  const low = Math.min(p10, p90);
  const high = Math.max(p10, p90);
  const scale = box.height / max;
  const y = box.height - Math.min(high, max) * scale;
  const height = Math.max((Math.min(high, max) - Math.max(low, 0)) * scale, 1);
  return { y, height };
}

/** x positions of the minutes that acquired nothing, drawn as grey stripes. */
export function idleStripes(idleFlags: boolean[], box: ChartBox): { x: number; width: number }[] {
  if (idleFlags.length === 0) return [];
  const width = box.width / idleFlags.length;
  return idleFlags
    .map((idle, index) => ({ idle, x: index * width, width }))
    .filter((s) => s.idle)
    .map(({ x, width: w }) => ({ x, width: w }));
}

/** Nice round upper bound so the top gridline is a readable number. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

/** The six stacked segments of the phase bar, in pipeline order. */
export interface PhaseSegment {
  key: string;
  label: string;
  count: number;
  /** Share of the whole, 0-100. */
  percent: number;
}

export interface PhaseCounts {
  discovered: number;
  fetching: number;
  preserved: number;
  processed: number;
  indexed: number;
  failed: number;
  skipped: number;
}

/**
 * Turn item-state counts into stacked segments.
 *
 * `processed` and `indexed` are one segment: from a user's side both mean "this
 * item is done", and splitting them put a sliver on screen that nobody could
 * read. Zero-count states are dropped entirely — a 0%-wide flex child still
 * paints its border and reads as a real slice.
 *
 * This bar is what finally makes the processing tail visible. On the real run
 * 27.22 of 93.22 hours happened after the last byte arrived, all of it as items
 * moving from `preserved` to `indexed`, and no screen showed it.
 */
export function phaseSegments(counts: PhaseCounts): PhaseSegment[] {
  const total =
    counts.discovered +
    counts.fetching +
    counts.preserved +
    counts.processed +
    counts.indexed +
    counts.failed +
    counts.skipped;
  const raw: { key: string; label: string; count: number }[] = [
    { key: 'discovered', label: 'Discovered, not fetched', count: counts.discovered },
    { key: 'fetching', label: 'Fetching', count: counts.fetching },
    { key: 'preserved', label: 'Preserved, awaiting processing', count: counts.preserved },
    { key: 'done', label: 'Processed and indexed', count: counts.processed + counts.indexed },
    { key: 'failed', label: 'Failed', count: counts.failed },
    { key: 'skipped', label: 'Skipped', count: counts.skipped },
  ];
  if (total === 0) return [];
  return raw
    .filter((segment) => segment.count > 0)
    .map((segment) => ({ ...segment, percent: (segment.count / total) * 100 }));
}

/** Elapsed milliseconds as "3 d 21 h 13 m". Never a remaining time. */
export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 m';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)} d`);
  if (hours > 0) parts.push(`${String(hours)} h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${String(minutes)} m`);
  return parts.join(' ');
}

export interface SparklineLabelInput {
  /** Name of the measured window, from the API. Never inferred here. */
  windowName: string;
  items: number;
  bytes: number;
  /** null while measuring. Never printed as 0 — that reads as stalled. */
  itemsPerMinute: number | null;
  bytesPerMinute: number | null;
  p10ItemsPerMinute: number | null;
  p90ItemsPerMinute: number | null;
  peakItemsPerMinute: number | null;
  idleBuckets: number;
}

/**
 * The sparkline's accessible name: the figures, in the order a person asks for
 * them. No shape words, and no pace at all when there is none to state.
 */
export function sparklineLabel(input: SparklineLabelInput): string {
  const parts = [
    `Acquisition throughput, ${input.windowName}`,
    `${groupDigits(input.items)} items, ${shortBytes(input.bytes)}`,
  ];
  if (input.itemsPerMinute === null || input.bytesPerMinute === null) {
    // Honest, and deliberately not "0 per minute".
    parts.push('pace not measured yet');
  } else {
    parts.push(
      `${groupDigits(input.itemsPerMinute)} items per minute, ${shortBytes(input.bytesPerMinute)} per minute`,
    );
  }
  if (input.p10ItemsPerMinute !== null && input.p90ItemsPerMinute !== null) {
    parts.push(
      `a typical minute of this run is ${groupDigits(input.p10ItemsPerMinute)} to ${groupDigits(input.p90ItemsPerMinute)} items`,
    );
  }
  if (input.peakItemsPerMinute !== null) {
    parts.push(`busiest minute ${groupDigits(input.peakItemsPerMinute)} items`);
  }
  parts.push(
    input.idleBuckets === 1
      ? '1 bucket acquired nothing'
      : `${groupDigits(input.idleBuckets)} buckets acquired nothing`,
  );
  return `${parts.join('. ')}.`;
}

/** The area chart's accessible name. States bytes, and says it is not projected. */
export function areaLabel(input: { windowName: string; cumulativeBytes: number }): string {
  return (
    `Bytes preserved over time, ${input.windowName}. ` +
    `${shortBytes(input.cumulativeBytes)} preserved so far. ` +
    'The final total is not shown because it is not yet known.'
  );
}

/** The phase bar's accessible name: every segment, counted. */
export function phaseBarLabel(segments: PhaseSegment[], total: number): string {
  if (segments.length === 0) return 'Item states: nothing discovered yet.';
  const listed = segments
    .map((s) => `${s.label} ${groupDigits(s.count)}, ${s.percent.toFixed(1)} percent`)
    .join('; ');
  return `Item states out of ${groupDigits(total)} items: ${listed}.`;
}
