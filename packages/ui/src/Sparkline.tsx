import {
  bandRect,
  groupDigits,
  idleStripes,
  niceMax,
  polylinePoints,
  scaleSeries,
  shortBytes,
  sparklineLabel,
  type ChartBox,
} from './charts.js';
import { VisuallyHidden } from './VisuallyHidden.js';

/** One measured bucket, as the throughput contract returns it. */
export interface SparklineBucket {
  startedAt: string;
  minutesFromStart: number;
  items: number;
  bytes: number;
  idle: boolean;
}

export interface SparklinePace {
  itemsPerMinute: number | null;
  bytesPerMinute: number | null;
  p10ItemsPerMinute: number | null;
  p50ItemsPerMinute: number | null;
  p90ItemsPerMinute: number | null;
  peakItemsPerMinute: number | null;
}

export interface SparklineProps {
  /** The API's own name for the window. Never re-derived from the bucket count. */
  windowName: string;
  bucketMinutes: number;
  buckets: SparklineBucket[];
  pace: SparklinePace;
  totals: { items: number; bytes: number; idleBuckets: number };
  /** How many recent buckets the hidden table lists. */
  tableRows?: number;
}

const BOX: ChartBox = { width: 720, height: 160 };
const DEFAULT_TABLE_ROWS = 12;

/**
 * Two measured curves on one time axis: items per minute (solid, left axis) and
 * bytes per minute (dashed, right axis).
 *
 * Both are drawn because neither stands in for the other. Across 3,948 buckets
 * of the biggest real run, items per second and bytes per second correlated at
 * -0.143 — effectively zero. Item size ran from a 21 kB median to a 3,188 kB p99
 * and one 672 MB item, so a minute can be busy by count and slow by bytes, or
 * the reverse, and only showing one hides half of what is happening.
 *
 * Behind the lines sits a pale band at this run's OWN p10 to p90. That is what
 * makes a glance useful: it answers "is this minute normal for this job?" with
 * no prior knowledge of the job. The real run's band was 54 to 162 items per
 * minute against a 1,140-item peak.
 *
 * Minutes that acquired nothing get a grey vertical stripe. Without them a gap
 * is silently closed up and a stall looks like steady work; the real run had 12
 * such minutes out of 3,948.
 *
 * Accessibility, which is a requirement here rather than a polish pass: the
 * figures appear as text above the chart (so the page still works with CSS off),
 * the svg is a role="img" whose label states those figures, and a real table of
 * recent buckets follows it inside VisuallyHidden. Pace is NOT announced through
 * a live region — at a 5-second poll that would talk over everything else on the
 * page.
 */
export function Sparkline({
  windowName,
  bucketMinutes,
  buckets,
  pace,
  totals,
  tableRows = DEFAULT_TABLE_ROWS,
}: SparklineProps) {
  const itemRates = buckets.map((b) => b.items / bucketMinutes);
  const byteRates = buckets.map((b) => b.bytes / bucketMinutes);
  const itemMax = niceMax(Math.max(0, ...itemRates));
  const byteMax = niceMax(Math.max(0, ...byteRates));

  const itemPoints = scaleSeries(itemRates, BOX, itemMax);
  const bytePoints = scaleSeries(byteRates, BOX, byteMax);
  const band = bandRect(pace.p10ItemsPerMinute, pace.p90ItemsPerMinute, BOX, itemMax);
  const stripes = idleStripes(
    buckets.map((b) => b.idle),
    BOX,
  );
  const label = sparklineLabel({
    windowName,
    items: totals.items,
    bytes: totals.bytes,
    itemsPerMinute: pace.itemsPerMinute,
    bytesPerMinute: pace.bytesPerMinute,
    p10ItemsPerMinute: pace.p10ItemsPerMinute,
    p90ItemsPerMinute: pace.p90ItemsPerMinute,
    peakItemsPerMinute: pace.peakItemsPerMinute,
    idleBuckets: totals.idleBuckets,
  });
  const recent = buckets.slice(-tableRows);

  return (
    <figure className="cdfir-chart">
      <figcaption className="cdfir-chart__caption">
        Acquisition throughput &mdash; {windowName}
      </figcaption>
      {/* Headline figures as ordinary text, above the picture. With CSS off
          these are still the answer; the chart only adds the shape. */}
      <p className="cdfir-chart__headline">
        {groupDigits(totals.items)} items &middot; {shortBytes(totals.bytes)} &middot;{' '}
        {pace.itemsPerMinute === null || pace.bytesPerMinute === null
          ? 'pace not measured yet'
          : `${groupDigits(pace.itemsPerMinute)} items/min · ${shortBytes(pace.bytesPerMinute)}/min`}
        {pace.p10ItemsPerMinute !== null && pace.p90ItemsPerMinute !== null
          ? ` · typical minute ${groupDigits(pace.p10ItemsPerMinute)}–${groupDigits(pace.p90ItemsPerMinute)} items`
          : ''}
      </p>
      <svg
        role="img"
        aria-label={label}
        className="cdfir-chart__svg"
        viewBox={`0 0 ${String(BOX.width)} ${String(BOX.height)}`}
        preserveAspectRatio="none"
      >
        {band ? (
          <rect
            className="cdfir-chart__band"
            x={0}
            y={band.y}
            width={BOX.width}
            height={band.height}
          />
        ) : null}
        {stripes.map((stripe) => (
          <rect
            key={`idle-${String(stripe.x)}`}
            className="cdfir-chart__idle"
            x={stripe.x}
            y={0}
            width={stripe.width}
            height={BOX.height}
          />
        ))}
        {itemPoints.length > 1 ? (
          <polyline className="cdfir-chart__line" points={polylinePoints(itemPoints)} />
        ) : null}
        {bytePoints.length > 1 ? (
          <polyline
            className="cdfir-chart__line cdfir-chart__line--bytes"
            points={polylinePoints(bytePoints)}
          />
        ) : null}
      </svg>
      {/* Line style, not colour alone, tells the two series apart. */}
      <ul className="cdfir-chart__legend">
        <li>
          <span aria-hidden="true" className="cdfir-chart__swatch cdfir-chart__swatch--items" />
          Items per minute (solid, left axis), peak of axis {groupDigits(itemMax)}
        </li>
        <li>
          <span aria-hidden="true" className="cdfir-chart__swatch cdfir-chart__swatch--bytes" />
          Bytes per minute (dashed, right axis), peak of axis {shortBytes(byteMax)}
        </li>
        <li>
          <span aria-hidden="true" className="cdfir-chart__swatch cdfir-chart__swatch--band" />
          Shaded: this run&rsquo;s own 10th to 90th percentile minute
        </li>
        <li>
          <span aria-hidden="true" className="cdfir-chart__swatch cdfir-chart__swatch--idle" />
          Grey stripe: acquired nothing
        </li>
      </ul>
      <VisuallyHidden>
        <table>
          <caption>Most recent {String(recent.length)} buckets of acquisition throughput</caption>
          <thead>
            <tr>
              <th scope="col">Minutes from start</th>
              <th scope="col">Bucket start</th>
              <th scope="col">Items</th>
              <th scope="col">Bytes</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((bucket) => (
              <tr key={bucket.startedAt}>
                <td>{groupDigits(bucket.minutesFromStart)}</td>
                <td>{bucket.startedAt}</td>
                <td>{groupDigits(bucket.items)}</td>
                <td>{shortBytes(bucket.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </VisuallyHidden>
    </figure>
  );
}
