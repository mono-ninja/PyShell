import { describe, it, expect } from "vitest";
import { labelTicks } from "./ChartView";

// Mirrors the geometry the chart is drawn with: 600px wide, 48px left pad,
// 16px right pad. A line chart puts points at both edges, so n-1 gaps; a bar
// chart centres each bar in its own slot, so n.
const PLOT_W = 600 - 48 - 16;
const lineStep = (n: number) => (n > 1 ? PLOT_W / (n - 1) : PLOT_W);
const barStep = (n: number) => (n > 0 ? PLOT_W / n : PLOT_W);

const labels = (n: number, text: (i: number) => string = (i) => `#${i + 1}`) =>
  Array.from({ length: n }, (_, i) => text(i));

/** The text width the component assumes: 10 chars max, 5.4px each. */
const drawnWidth = (ls: string[]) =>
  Math.max(...ls.map((l) => Math.min(l.length, 10))) * 5.4;

describe("labelTicks", () => {
  it("draws every label when there is room", () => {
    expect(labelTicks(labels(4), lineStep(4))).toEqual([0, 1, 2, 3]);
    expect(labelTicks(["/", "/api", "/login"], barStep(3))).toEqual([0, 1, 2]);
  });

  it("handles zero and one label", () => {
    expect(labelTicks([], lineStep(0))).toEqual([]);
    expect(labelTicks(["only"], lineStep(1))).toEqual([0]);
  });

  it("thins a long timeline down to something readable", () => {
    // The case that motivated this: 500 points across ~536px is ~1px each.
    const ticks = labelTicks(labels(500), lineStep(500));
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(20);
  });

  it("never places two labels closer than their own width", () => {
    for (const n of [2, 3, 5, 13, 39, 40, 41, 60, 128, 500, 5000]) {
      for (const step of [lineStep(n), barStep(n)]) {
        const ls = labels(n);
        const ticks = labelTicks(ls, step);
        const width = drawnWidth(ls);
        for (let i = 1; i < ticks.length; i++) {
          const gap = (ticks[i] - ticks[i - 1]) * step;
          expect(gap, `n=${n} gap between ${ticks[i - 1]} and ${ticks[i]}`)
            .toBeGreaterThanOrEqual(width);
        }
      }
    }
  });

  it("adds the final label when the leftover gap clears it", () => {
    // 60 points, 4-char labels: the stride lands on 56, and 3 steps of ~9px
    // is enough room for a ~21.6px label… it is not, so it must be skipped.
    const ticks = labelTicks(labels(60, () => "#500"), lineStep(60));
    const width = drawnWidth(labels(60, () => "#500"));
    const last = ticks[ticks.length - 1];
    if (last === 59) {
      const prev = ticks[ticks.length - 2];
      expect((59 - prev) * lineStep(60)).toBeGreaterThanOrEqual(width);
    }
  });

  it("thins more aggressively for longer labels", () => {
    const short = labelTicks(labels(200), lineStep(200)).length;
    const long = labelTicks(labels(200, (i) => `endpoint-${i}`), lineStep(200)).length;
    expect(long).toBeLessThan(short);
  });

  it("stops widening once labels hit the truncation limit", () => {
    // Everything past 10 chars is cut to "…", so it cannot cost more room.
    const ten = labelTicks(labels(200, () => "0123456789"), lineStep(200));
    const huge = labelTicks(labels(200, () => "0123456789".repeat(8)), lineStep(200));
    expect(huge).toEqual(ten);
  });

  it("survives a degenerate step instead of dividing by zero", () => {
    expect(labelTicks(labels(10), 0)).toEqual([0]);
    expect(labelTicks(labels(10), Number.NaN)).toEqual([0]);
    expect(labelTicks(labels(10), -5)).toEqual([0]);
  });

  it("returns strictly increasing in-range indices", () => {
    for (const n of [2, 3, 7, 50, 999]) {
      const ticks = labelTicks(labels(n), lineStep(n));
      expect(ticks[0]).toBe(0);
      for (let i = 0; i < ticks.length; i++) {
        expect(Number.isInteger(ticks[i])).toBe(true);
        expect(ticks[i]).toBeLessThan(n);
        if (i > 0) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
      }
    }
  });
});
