/**
 * ANSI SGR (Select Graphic Rendition) parser.
 *
 * Pipes don't give us a PTY, but many tools emit SGR colour codes over a plain
 * pipe when `FORCE_COLOR` or `NO_COLOR=0` is set (Plan.md §2.3). This parser
 * turns `\x1b[31m…\x1b[0m` into styled segments for rendering as `<span>`s.
 *
 * Cursor-control sequences (`\x1b[2J`, `\x1b[?25l`, OSC, etc.) are silently
 * stripped — they have no meaning without a PTY.
 */

/** A run of text with the SGR attributes active at that point. */
export interface AnsiSegment {
  text: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  reverse: boolean;
  /** Colour index 0-255, or `[r, g, b]` for truecolor, or `null` = default. */
  fg: number | [number, number, number] | null;
  bg: number | [number, number, number] | null;
}

const EMPTY: AnsiSegment = {
  text: "",
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strikethrough: false,
  reverse: false,
  fg: null,
  bg: null,
};

/** Matches any CSI/OSC/other escape sequence — used to strip non-SGR codes. */
const ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g;

/** Matches a single SGR sequence (`\x1b[...m`) or any other escape. */
const SGR_RE = /\x1b\[([0-9;]*)m/g;

/**
 * Parse a line of text containing ANSI escape sequences into styled segments.
 * Non-SGR escape sequences are removed but do not affect the current style.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let current = { ...EMPTY };
  let buffer = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  SGR_RE.lastIndex = 0;
  while ((match = SGR_RE.exec(text)) !== null) {
    // Text before the escape sequence — flush it with the *current* style
    // (i.e. the style that was active before this SGR changes it).
    if (match.index > lastIndex) {
      buffer += text.slice(lastIndex, match.index);
    }
    if (buffer) {
      segments.push({ ...current, text: buffer });
      buffer = "";
    }

    // Apply SGR parameters — this changes the style for subsequent text.
    const params = match[1] === "" ? ["0"] : match[1].split(";");
    applySgr(current, params);

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after the last escape (or the entire string if no escapes).
  if (lastIndex < text.length) {
    buffer += text.slice(lastIndex);
  }

  // Strip any non-SGR escape sequences from the trailing text.
  if (buffer) {
    buffer = buffer.replace(ESCAPE_RE, "");
    segments.push({ ...current, text: buffer });
  }

  // If there were no segments at all (empty string or only escapes), return
  // a single empty segment so callers always get at least one entry.
  if (segments.length === 0) {
    segments.push({ ...EMPTY });
  }

  return segments;
}

/** Strip all ANSI escape sequences, returning plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPE_RE, "");
}

/** Apply a list of SGR parameter codes to a mutable style object. */
function applySgr(style: AnsiSegment, params: string[]): void {
  let i = 0;
  while (i < params.length) {
    const code = parseInt(params[i], 10);

    if (isNaN(code) || code === 0) {
      Object.assign(style, EMPTY);
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 7) {
      style.reverse = true;
    } else if (code === 9) {
      style.strikethrough = true;
    } else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) {
      style.italic = false;
    } else if (code === 24) {
      style.underline = false;
    } else if (code === 27) {
      style.reverse = false;
    } else if (code === 29) {
      style.strikethrough = false;
    } else if (code === 39) {
      style.fg = null;
    } else if (code === 49) {
      style.bg = null;
    } else if (code >= 30 && code <= 37) {
      style.fg = code - 30;
    } else if (code >= 40 && code <= 47) {
      style.bg = code - 40;
    } else if (code >= 90 && code <= 97) {
      style.fg = code - 90 + 8;
    } else if (code >= 100 && code <= 107) {
      style.bg = code - 100 + 8;
    } else if (code === 38 || code === 48) {
      // Extended colour: 38;5;N (256-colour) or 38;2;R;G;B (truecolor).
      const isFg = code === 38;
      const mode = parseInt(params[i + 1], 10);
      if (mode === 5) {
        const idx = parseInt(params[i + 2], 10);
        if (!isNaN(idx) && idx >= 0 && idx <= 255) {
          if (isFg) style.fg = idx;
          else style.bg = idx;
        }
        i += 2;
      } else if (mode === 2) {
        const r = parseInt(params[i + 2], 10);
        const g = parseInt(params[i + 3], 10);
        const b = parseInt(params[i + 4], 10);
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
          if (isFg) style.fg = [r, g, b];
          else style.bg = [r, g, b];
        }
        i += 4;
      }
    }

    i += 1;
  }
}

// --- 256-colour palette -----------------------------------------------------

/**
 * The xterm 256-colour palette as hex strings for inline styles.
 * Indices 0-7: standard, 8-15: bright, 16-231: 6×6×6 colour cube,
 * 232-255: grayscale ramp.
 */
const PALETTE_256: string[] = (() => {
  const pal: string[] = new Array(256);

  // Standard 16 (xterm defaults).
  const std16 = [
    "#000000", "#cc0000", "#4d9f00", "#c4a000",
    "#0066cc", "#cc00cc", "#00cccc", "#cccccc",
    "#666666", "#ff6666", "#99ff66", "#ffff66",
    "#66ccff", "#ff66ff", "#66ffff", "#ffffff",
  ];
  for (let i = 0; i < 16; i++) pal[i] = std16[i];

  // 6×6×6 colour cube (16-231).
  const cube = [0, 95, 135, 175, 215, 255];
  let idx = 16;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        pal[idx++] = `rgb(${cube[r]},${cube[g]},${cube[b]})`;
      }
    }
  }

  // Grayscale ramp (232-255).
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    pal[232 + i] = `rgb(${v},${v},${v})`;
  }

  return pal;
})();

/**
 * Build a CSS `color` value from a colour spec.
 * Returns `null` for default (no inline style needed).
 */
export function colorToCss(color: number | [number, number, number] | null): string | null {
  if (color === null) return null;
  if (Array.isArray(color)) return `rgb(${color[0]},${color[1]},${color[2]})`;
  if (color >= 0 && color <= 255) return PALETTE_256[color];
  return null;
}
