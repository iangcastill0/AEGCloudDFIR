import { groupDigits, phaseBarLabel, phaseSegments, type PhaseCounts } from './charts.js';
import { VisuallyHidden } from './VisuallyHidden.js';

export interface PhaseBarProps {
  /** `collection_items` state counts, grouped in the database. */
  counts: PhaseCounts;
  /** Shown above the bar; the caller names the collection or the phase. */
  caption: string;
}

/**
 * Where every item currently is, as one stacked bar.
 *
 * Flexbox rather than SVG. The segments are plain rectangles whose widths are
 * percentages, so the browser handles wrapping, text zoom and high-contrast mode
 * for free, and the counts can sit inside the segments as real text instead of
 * as <text> nodes a translation tool will not touch.
 *
 * This is the picture that finally shows the processing tail. On the biggest real
 * run, 27.22 of 93.22 hours — 29% — happened after the last byte arrived, as
 * items moved from `preserved` to `indexed`. Until now nothing on screen
 * distinguished "still downloading" from "downloaded, still being read", so a
 * collection that was 100% acquired looked stuck for over a day.
 *
 * Colour is never the only signal: every segment carries its name and its count
 * as text, and the whole bar is also a hidden table.
 */
export function PhaseBar({ counts, caption }: PhaseBarProps) {
  const segments = phaseSegments(counts);
  const total =
    counts.discovered +
    counts.fetching +
    counts.preserved +
    counts.processed +
    counts.indexed +
    counts.failed +
    counts.skipped;

  if (segments.length === 0) {
    return (
      <div className="cdfir-phasebar">
        <p className="cdfir-chart__caption">{caption}</p>
        <p>No items discovered yet.</p>
      </div>
    );
  }

  return (
    <div className="cdfir-phasebar">
      <p className="cdfir-chart__caption">{caption}</p>
      <div role="img" aria-label={phaseBarLabel(segments, total)} className="cdfir-phasebar__track">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={`cdfir-phasebar__segment cdfir-phasebar__segment--${segment.key}`}
            style={{ flexBasis: `${segment.percent.toFixed(2)}%` }}
          >
            <span className="cdfir-phasebar__segment-count">{groupDigits(segment.count)}</span>
          </div>
        ))}
      </div>
      {/* The key repeats every number, so the bar is never the only source. */}
      <ul className="cdfir-phasebar__key">
        {segments.map((segment) => (
          <li key={segment.key}>
            <span
              aria-hidden="true"
              className={`cdfir-phasebar__swatch cdfir-phasebar__swatch--${segment.key}`}
            />
            {segment.label}: {groupDigits(segment.count)} ({segment.percent.toFixed(1)}%)
          </li>
        ))}
      </ul>
      <VisuallyHidden>
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Item state</th>
              <th scope="col">Items</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((segment) => (
              <tr key={segment.key}>
                <td>{segment.label}</td>
                <td>{groupDigits(segment.count)}</td>
                <td>{segment.percent.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </VisuallyHidden>
    </div>
  );
}
