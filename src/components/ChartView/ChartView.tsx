import type { ChartData } from "../../hooks/useJobs";

interface ChartViewProps {
  chart: ChartData;
}

const W = 600;
const H = 300;
const PAD_L = 48;
const PAD_R = 16;
const PAD_T = 24;
const PAD_B = 36;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

const COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#84cc16", "#a855f7",
];

/** X labels are truncated to this many characters before being drawn. */
const LABEL_MAX_CHARS = 10;
/** Rough advance width of one character at `font-size: 9px`, rounded up: an
 *  over-estimate drops a label that would have fitted, an under-estimate lets
 *  two labels overlap, and overlap is the worse failure. */
const LABEL_CHAR_W = 5.4;
/** Clear space kept between two neighbouring labels. */
const LABEL_GAP = 6;

/** Drawn width of the widest label, after truncation. */
function widestLabel(labels: string[]): number {
  let chars = 0;
  for (const l of labels) chars = Math.max(chars, Math.min(l.length, LABEL_MAX_CHARS));
  return chars * LABEL_CHAR_W;
}

/**
 * Which label indices to draw so that no two of them overlap.
 *
 * Every label used to be drawn, which is fine for a handful of categories and
 * unreadable for a timeline: a few hundred labels across ~530px collapse into a
 * grey smear. `step` is the distance between neighbouring label positions, so
 * the stride is how many of those steps one label needs to itself.
 *
 * Exported for tests.
 */
export function labelTicks(labels: string[], step: number): number[] {
  const n = labels.length;
  if (n === 0) return [];
  // A single label, or a degenerate geometry with nowhere to put a second one.
  if (n === 1 || !Number.isFinite(step) || step <= 0) return [0];

  const width = widestLabel(labels);
  const stride = Math.max(1, Math.ceil((width + LABEL_GAP) / step));
  const ticks: number[] = [];
  for (let i = 0; i < n; i += stride) ticks.push(i);

  // The last label names the newest point of a timeline, so it is worth adding
  // when the stride skipped it — but only if the leftover gap clears the text.
  // It only has to clear the glyphs, not the padding a regular stride keeps,
  // which is why this is not simply another stride check.
  const last = ticks[ticks.length - 1];
  if (last !== n - 1 && (n - 1 - last) * step >= width) ticks.push(n - 1);
  return ticks;
}

export function ChartView({ chart }: ChartViewProps) {
  const { chartType, title, labels, series } = chart;
  const allValues = series.flatMap((s) => s.values);
  const maxVal = allValues.length > 0 ? Math.max(...allValues) : 1;
  const minVal = allValues.length > 0 ? Math.min(...allValues, 0) : 0;
  const range = maxVal - minVal || 1;
  const n = labels.length;
  // Line charts: points at edges → PLOT_W / (n-1).
  // Bar charts: bars centered in equal-width slots → PLOT_W / n.
  const stepXLine = n > 1 ? PLOT_W / (n - 1) : PLOT_W;
  const stepXBar = n > 0 ? PLOT_W / n : PLOT_W;
  const slotW = stepXBar;

  const yScale = (v: number) => PAD_T + PLOT_H - ((v - minVal) / range) * PLOT_H;
  const xScaleLine = (i: number) => PAD_L + (n > 1 ? i * stepXLine : PLOT_W / 2);
  const xScaleBar = (i: number) => PAD_L + i * stepXBar + stepXBar / 2;

  const gridLines = 4;
  const gridVals = Array.from({ length: gridLines + 1 }, (_, i) => minVal + (range * i) / gridLines);

  const ticks = new Set(labelTicks(labels, chartType === "bar" ? stepXBar : stepXLine));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} class="w-full" style="max-width: 600px;">
      {title && (
        <text x={W / 2} y={14} text-anchor="middle" class="fill-fg" style="font-size: 13px; font-weight: 600;">
          {title}
        </text>
      )}

      {/* Grid + Y axis labels */}
      {gridVals.map((v, i) => (
        <g key={i}>
          <line
            x1={PAD_L} y1={yScale(v)} x2={W - PAD_R} y2={yScale(v)}
            stroke="var(--color-line)" stroke-width="0.5" opacity="0.6"
          />
          <text x={PAD_L - 6} y={yScale(v) + 3} text-anchor="end" class="fill-subtle" style="font-size: 9px;">
            {formatNum(v)}
          </text>
        </g>
      ))}

      {/* X axis labels — thinned so they cannot overlap. Bars keep the same
          rule: an unlabelled bar is still readable next to a labelled one,
          two labels drawn on top of each other are not. */}
      {labels.map((label, i) => {
        if (!ticks.has(i)) return null;
        const x = chartType === "bar" ? xScaleBar(i) : xScaleLine(i);
        return (
          <text
            key={i}
            x={x} y={H - PAD_B + 14}
            text-anchor="middle" class="fill-subtle"
            style="font-size: 9px;"
          >
            {truncate(label, LABEL_MAX_CHARS)}
          </text>
        );
      })}

      {/* Zero line */}
      {minVal < 0 && maxVal > 0 && (
        <line
          x1={PAD_L} y1={yScale(0)} x2={W - PAD_R} y2={yScale(0)}
          stroke="var(--color-muted)" stroke-width="0.75" opacity="0.8"
        />
      )}

      {chartType === "line" && series.map((s, si) => {
        const points = s.values.map((v, i) => `${xScaleLine(i)},${yScale(v)}`).join(" ");
        const color = COLORS[si % COLORS.length];
        return (
          <g key={si}>
            <polyline
              points={points}
              fill="none" stroke={color} stroke-width="1.5"
              stroke-linejoin="round" stroke-linecap="round"
            />
            {s.values.map((v, i) => (
              <circle key={i} cx={xScaleLine(i)} cy={yScale(v)} r="2.5" fill={color} />
            ))}
          </g>
        );
      })}

      {chartType === "bar" && series.map((s, si) => {
        const groupW = slotW * 0.8;
        const barW = series.length > 0 ? groupW / series.length : groupW;
        const color = COLORS[si % COLORS.length];
        return s.values.map((v, i) => {
          const barH = Math.abs(yScale(v) - yScale(0));
          const barY = v >= 0 ? yScale(v) : yScale(0);
          const groupX = xScaleBar(i) - groupW / 2;
          return (
            <rect
              key={`${si}-${i}`}
              x={groupX + si * barW} y={barY}
              width={Math.max(0, barW - 1)} height={barH}
              fill={color} rx="1"
            />
          );
        });
      })}

      {/* Legend — placed below the X-axis labels to avoid overlap */}
      {series.length > 1 && (
        <g>
          {series.map((s, i) => {
            const legendX = PAD_L + (i % 3) * 180;
            const legendY = H - 8 - Math.floor(i / 3) * 12;
            return (
              <g key={i} transform={`translate(${legendX}, ${legendY})`}>
                <rect width="8" height="8" fill={COLORS[i % COLORS.length]} rx="1" y="-7" />
                <text x="12" y="0" class="fill-muted" style="font-size: 9px;">{truncate(s.name, 16)}</text>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}

function formatNum(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
