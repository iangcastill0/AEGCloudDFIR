import {
  areaLabel,
  areaPath,
  niceMax,
  polylinePoints,
  scaleSeries,
  shortBytes,
  groupDigits,
  type ChartBox,
} from './charts.js';
import { VisuallyHidden } from './VisuallyHidden.js';

export interface AreaChartBucket {
  startedAt: string;
  minutesFromStart: number;
  cumulativeBytes: number;
}

export interface AreaChartProps {
  /** The API's own name for the window. */
  windowName: string;
  buckets: AreaChartBucket[];
  tableRows?: number;
}

const BOX: ChartBox = { width: 720, height: 120 };
const DEFAULT_TABLE_ROWS = 12;

/**
 * Bytes preserved, cumulative.
 *
 * The line STOPS at the last measurement and is never extended forward. That is
 * not caution, it is the only truthful option: 249,531 of the biggest real run's
 * 434,910 evidence items were attachments that `parse` created after their
 * parent had already been counted, so during a run the eventual total does not
 * exist yet to be aimed at. A line sloping towards a guessed 130 GB would look
 * like a measurement and be a forecast.
 *
 * Same accessibility contract as the sparkline: figures as text, a role="img"
 * label carrying those figures, and a real table of recent points after the svg.
 */
export function AreaChart({ windowName, buckets, tableRows = DEFAULT_TABLE_ROWS }: AreaChartProps) {
  const values = buckets.map((b) => b.cumulativeBytes);
  const last = values.length > 0 ? (values[values.length - 1] ?? 0) : 0;
  const max = niceMax(Math.max(0, ...values));
  const points = scaleSeries(values, BOX, max);
  const recent = buckets.slice(-tableRows);

  return (
    <figure className="cdfir-chart">
      <figcaption className="cdfir-chart__caption">Bytes preserved &mdash; {windowName}</figcaption>
      <p className="cdfir-chart__headline">
        {shortBytes(last)} preserved so far. No final total is shown: it is not yet known.
      </p>
      <svg
        role="img"
        aria-label={areaLabel({ windowName, cumulativeBytes: last })}
        className="cdfir-chart__svg cdfir-chart__svg--area"
        viewBox={`0 0 ${String(BOX.width)} ${String(BOX.height)}`}
        preserveAspectRatio="none"
      >
        {points.length > 1 ? (
          <>
            <path className="cdfir-chart__area" d={areaPath(points, BOX)} />
            <polyline className="cdfir-chart__line" points={polylinePoints(points)} />
          </>
        ) : null}
      </svg>
      <VisuallyHidden>
        <table>
          <caption>Most recent {String(recent.length)} cumulative byte measurements</caption>
          <thead>
            <tr>
              <th scope="col">Minutes from start</th>
              <th scope="col">Bucket start</th>
              <th scope="col">Bytes preserved so far</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((bucket) => (
              <tr key={bucket.startedAt}>
                <td>{groupDigits(bucket.minutesFromStart)}</td>
                <td>{bucket.startedAt}</td>
                <td>{shortBytes(bucket.cumulativeBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </VisuallyHidden>
    </figure>
  );
}
