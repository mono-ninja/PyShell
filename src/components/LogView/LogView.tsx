import { useEffect, useRef, useState, useCallback, useMemo } from "preact/hooks";
import { save } from "@tauri-apps/plugin-dialog";
import { copyFile } from "@tauri-apps/plugin-fs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { LogLine } from "../../types/schema";
import { useToast } from "../Toast";
import { WrapIcon } from "../icons";
import { parseAnsi, stripAnsi, colorToCss, type AnsiSegment } from "../../lib/ansi";

interface LogViewProps {
  lines: LogLine[];
  autoScroll: boolean;
  logFilePath?: string;
}

// Hard cap on the ANSI parse/strip cache: the key is the full line text, so
// without eviction a chatty run with unique lines grows it without bound
// (Plan.md §3.4).
const ANSI_CACHE_MAX = 50_000;

const stripCache = new Map<string, string>();
function stripAnsiCached(text: string): string {
  let cached = stripCache.get(text);
  if (cached === undefined) {
    if (stripCache.size >= ANSI_CACHE_MAX) {
      const first = stripCache.keys().next().value;
      if (first !== undefined) stripCache.delete(first);
    }
    cached = stripAnsi(text);
    stripCache.set(text, cached);
  }
  return cached;
}

const parseCache = new Map<string, AnsiSegment[]>();
function parseAnsiCached(text: string): AnsiSegment[] {
  let cached = parseCache.get(text);
  if (cached === undefined) {
    if (parseCache.size >= ANSI_CACHE_MAX) {
      const first = parseCache.keys().next().value;
      if (first !== undefined) parseCache.delete(first);
    }
    cached = parseAnsi(text);
    parseCache.set(text, cached);
  }
  return cached;
}

/** Render parsed ANSI segments as styled `<span>`s (Plan.md §2.3). */
function renderSegments(segments: AnsiSegment[]): preact.ComponentChild[] {
  return segments.map((seg, i) => {
    let fg = seg.fg;
    let bg = seg.bg;
    if (seg.reverse) { const tmp = fg; fg = bg; bg = tmp; }

    const style: Record<string, string> = {};
    const fgCss = colorToCss(fg);
    const bgCss = colorToCss(bg);
    if (fgCss) style.color = fgCss;
    if (bgCss) style.background = bgCss;
    if (seg.bold) style["font-weight"] = "600";
    if (seg.dim) style.opacity = "0.5";
    if (seg.italic) style["font-style"] = "italic";
    const decos: string[] = [];
    if (seg.underline) decos.push("underline");
    if (seg.strikethrough) decos.push("line-through");
    if (decos.length) style["text-decoration"] = decos.join(" ");

    if (Object.keys(style).length === 0) return seg.text;
    return <span key={i} style={style}>{seg.text}</span>;
  });
}

const ROW_HEIGHT = 18;
const BUFFER_ROWS = 20;
const MAX_RENDER = 5000;

type StreamFilter = "all" | "stdout" | "stderr";

function measureCharWidth(): number {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return 7.2;
    ctx.font = '12px "SF Mono", "JetBrains Mono", "Fira Code", Menlo, monospace';
    return ctx.measureText("M").width || 7.2;
  } catch {
    return 7.2;
  }
}

export function LogView({ lines, autoScroll, logFilePath }: LogViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [filter, setFilter] = useState<StreamFilter>("all");
  const [search, setSearch] = useState("");
  const [userScrolled, setUserScrolled] = useState(false);
  const [hasLines, setHasLines] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [charWidth, setCharWidth] = useState(7.2);
  const { notifyError } = useToast();

  // Measure the monospace advance width once; used to estimate wrapped row
  // counts for variable-height virtualization.
  useEffect(() => {
    setCharWidth(measureCharWidth());
  }, []);

  // Filter lines
  const filteredLines = useMemo(() => {
    let result = lines;
    if (filter !== "all") {
      result = result.filter((l) => l.stream === filter);
    }
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((l) => l.text.toLowerCase().includes(lower));
    }
    return result;
  }, [lines, filter, search]);

  // Counted once per change, not per render: `lines` can hold up to 500k entries
  // and the toolbar re-renders on every incoming batch.
  const streamCounts = useMemo(() => {
    let stdout = 0;
    for (const l of lines) if (l.stream === "stdout") stdout++;
    return { stdout, stderr: lines.length - stdout };
  }, [lines]);

  // Variable-height layout for wrap mode. Each line's height is estimated from
  // its stripped length and the viewport width; a prefix sum gives O(log n)
  // lookup for the visible window. Recomputed on lines / width / wrap change.
  const layout = useMemo(() => {
    if (!wrap) return null;
    // px-5 padding on both sides of the scroll container.
    const available = Math.max(1, viewportWidth - 40);
    const n = filteredLines.length;
    const offsets = new Float64Array(n + 1);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      offsets[i] = acc;
      const textLen = stripAnsiCached(filteredLines[i].text).length;
      const rows = Math.max(1, Math.ceil((textLen * charWidth) / available));
      acc += rows * ROW_HEIGHT;
    }
    offsets[n] = acc;
    return offsets;
  }, [filteredLines, wrap, viewportWidth, charWidth]);

  const totalHeight = layout ? layout[filteredLines.length] : filteredLines.length * ROW_HEIGHT;

  // Find the first visible line. Fixed height: simple division. Wrap: binary
  // search the prefix sum for the largest offset <= scrollTop.
  const startIdx = useMemo(() => {
    if (!layout) return Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
    let lo = 0;
    let hi = filteredLines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (layout[mid] <= scrollTop) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1 - BUFFER_ROWS);
  }, [layout, scrollTop, filteredLines.length]);

  const visibleCount = Math.min(MAX_RENDER, Math.ceil(viewportHeight / ROW_HEIGHT) + BUFFER_ROWS * 2);
  const endIdx = Math.min(filteredLines.length, startIdx + visibleCount);
  const visibleLines = filteredLines.slice(startIdx, endIdx);

  // Track viewport size — re-attach when lines first appear (audit H8).
  useEffect(() => {
    if (!hasLines || !containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportHeight(entry.contentRect.height);
        setViewportWidth(entry.contentRect.width);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [hasLines]);

  // Detect when lines first arrive
  useEffect(() => {
    if (lines.length > 0 && !hasLines) setHasLines(true);
  }, [lines.length, hasLines]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && !userScrolled && containerRef.current) {
      containerRef.current.scrollTop = totalHeight;
    }
  }, [totalHeight, autoScroll, userScrolled]);

  // Reset userScrolled when autoScroll is toggled back on
  useEffect(() => {
    if (autoScroll) setUserScrolled(false);
  }, [autoScroll]);

  // Throttled scroll handler using rAF (audit M13)
  const handleScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (!containerRef.current) return;
      const el = containerRef.current;
      setScrollTop(el.scrollTop);
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 3;
      setUserScrolled((prev) => {
        if (!atBottom && autoScroll) return true;
        if (atBottom) return false;
        return prev;
      });
    });
  }, [autoScroll]);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const handleCopy = useCallback(async () => {
    const text = filteredLines.map((l) => l.text).join("\n");
    try {
      await writeText(text);
    } catch {
      try { await navigator.clipboard.writeText(text); } catch {}
    }
  }, [filteredLines]);

  // Use copyFile for export — handles binary logs too (audit M14)
  const handleExport = useCallback(async () => {
    if (!logFilePath) return;
    try {
      const dest = await save({ defaultPath: "pyshell-output.log" });
      if (dest) {
        await copyFile(logFilePath, dest);
      }
    } catch (e) {
      notifyError(e, "Export failed");
    }
  }, [logFilePath, notifyError]);

  if (lines.length === 0) {
    return (
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 text-center">
        <span class="font-mono text-xl text-subtle opacity-50">{"{ }"}</span>
        <p class="text-[13px] text-muted">No output yet</p>
        <p class="text-2xs text-subtle">Press Run — stdout and stderr stream in live.</p>
      </div>
    );
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-app">
      {/* Toolbar */}
      <div class="flex shrink-0 items-center gap-2 border-b border-line px-5 py-2">
        <select
          class="form-input w-auto py-1 text-xs"
          aria-label="Filter by stream"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value as StreamFilter)}
        >
          <option value="all">All ({lines.length})</option>
          <option value="stdout">stdout ({streamCounts.stdout})</option>
          <option value="stderr">stderr ({streamCounts.stderr})</option>
        </select>
        <input
          type="text"
          class="form-input flex-1 py-1 text-xs"
          aria-label="Search log output"
          placeholder="Search output…"
          value={search}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        {filteredLines.length < lines.length && (
          <span class="shrink-0 tabular-nums text-2xs text-subtle">
            {filteredLines.length} / {lines.length}
          </span>
        )}
        <button
          type="button"
          class={`btn py-1 ${wrap ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setWrap((w) => !w)}
          title={wrap ? "Wrapping long lines — click to truncate" : "Truncating long lines — click to wrap"}
          aria-pressed={wrap}
        >
          <WrapIcon size={13} />
          Wrap
        </button>
        <button type="button" class="btn btn-secondary py-1" onClick={handleCopy}>
          Copy
        </button>
        {logFilePath && (
          <button type="button" class="btn btn-secondary py-1" onClick={handleExport}>
            Export
          </button>
        )}
      </div>
      {/* Virtualized log */}
      <div
        ref={containerRef}
        class="flex-1 overflow-y-auto px-5 py-2"
        onScroll={handleScroll}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          <div style={{ position: "absolute", top: layout ? layout[startIdx] : startIdx * ROW_HEIGHT, left: 0, right: 0 }}>
            {visibleLines.map((line, i) => (
              <div
                key={startIdx + i}
                class={`log-line ${wrap ? "log-line-wrap" : line.stream === "stderr" ? "log-stderr" : "log-stdout"}`}
                style={{ height: layout ? undefined : ROW_HEIGHT }}
              >
                {renderSegments(parseAnsiCached(line.text))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
