export interface ProgressBarProps {
  /** Accessible name, e.g. "alice@example.com email: fetched". */
  label: string;
  value: number;
  max: number;
  /** Extra text shown next to the bar (counts are always shown as text). */
  detail?: string;
}

export function ProgressBar({ label, value, max, detail }: ProgressBarProps) {
  const safeMax = max > 0 ? max : 0;
  const clamped = Math.min(Math.max(value, 0), safeMax > 0 ? safeMax : value);
  const percent = safeMax > 0 ? Math.round((clamped / safeMax) * 100) : 0;
  return (
    <div className="cdfir-progress">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={`${clamped} of ${safeMax}${detail ? ` (${detail})` : ''}`}
        className="cdfir-progress__track"
      >
        <div className="cdfir-progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="cdfir-progress__text">
        {clamped} / {safeMax}
        {detail ? ` · ${detail}` : ''}
      </span>
    </div>
  );
}
