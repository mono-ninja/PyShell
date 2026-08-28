import { describe, it, expect } from "vitest";
import { parseAnsi, stripAnsi, colorToCss } from "./ansi";

// --- stripAnsi -------------------------------------------------------------

describe("stripAnsi", () => {
  it("removes simple SGR codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes multiple codes", () => {
    expect(stripAnsi("\x1b[1;31mbold red\x1b[0m text")).toBe("bold red text");
  });

  it("removes cursor control sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[Hclear")).toBe("clear");
  });

  it("removes OSC sequences", () => {
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  it("handles plain text without escapes", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

// --- parseAnsi -------------------------------------------------------------

describe("parseAnsi", () => {
  it("plain text → single segment with default style", () => {
    const segs = parseAnsi("hello");
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("hello");
    expect(segs[0].bold).toBe(false);
    expect(segs[0].fg).toBeNull();
  });

  it("empty string → single empty segment", () => {
    const segs = parseAnsi("");
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("");
  });

  it("simple foreground colour", () => {
    const segs = parseAnsi("\x1b[31mred text\x1b[0m");
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("red text");
    expect(segs[0].fg).toBe(1);
  });

  it("reset clears all attributes", () => {
    const segs = parseAnsi("\x1b[1;31mbold red\x1b[0m normal");
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe("bold red");
    expect(segs[0].bold).toBe(true);
    expect(segs[0].fg).toBe(1);
    expect(segs[1].text).toBe(" normal");
    expect(segs[1].bold).toBe(false);
    expect(segs[1].fg).toBeNull();
  });

  it("bold (1) and not bold (22)", () => {
    const segs = parseAnsi("\x1b[1mbold\x1b[22m not");
    expect(segs[0].bold).toBe(true);
    expect(segs[1].bold).toBe(false);
  });

  it("dim (2)", () => {
    const segs = parseAnsi("\x1b[2mdim\x1b[0m");
    expect(segs[0].dim).toBe(true);
  });

  it("italic (3) and not italic (23)", () => {
    const segs = parseAnsi("\x1b[3mitalic\x1b[23m not");
    expect(segs[0].italic).toBe(true);
    expect(segs[1].italic).toBe(false);
  });

  it("underline (4) and not underline (24)", () => {
    const segs = parseAnsi("\x1b[4munder\x1b[24m not");
    expect(segs[0].underline).toBe(true);
    expect(segs[1].underline).toBe(false);
  });

  it("strikethrough (9) and not (29)", () => {
    const segs = parseAnsi("\x1b[9mstrike\x1b[29m not");
    expect(segs[0].strikethrough).toBe(true);
    expect(segs[1].strikethrough).toBe(false);
  });

  it("reverse (7) and not (27)", () => {
    const segs = parseAnsi("\x1b[7mrev\x1b[27m not");
    expect(segs[0].reverse).toBe(true);
    expect(segs[1].reverse).toBe(false);
  });

  it("standard foreground colours 30-37", () => {
    for (let i = 0; i < 8; i++) {
      const segs = parseAnsi(`\x1b[${30 + i}mx`);
      expect(segs[0].fg).toBe(i);
    }
  });

  it("standard background colours 40-47", () => {
    for (let i = 0; i < 8; i++) {
      const segs = parseAnsi(`\x1b[${40 + i}mx`);
      expect(segs[0].bg).toBe(i);
    }
  });

  it("bright foreground colours 90-97", () => {
    for (let i = 0; i < 8; i++) {
      const segs = parseAnsi(`\x1b[${90 + i}mx`);
      expect(segs[0].fg).toBe(i + 8);
    }
  });

  it("bright background colours 100-107", () => {
    for (let i = 0; i < 8; i++) {
      const segs = parseAnsi(`\x1b[${100 + i}mx`);
      expect(segs[0].bg).toBe(i + 8);
    }
  });

  it("default fg (39) and bg (49)", () => {
    const segs = parseAnsi("\x1b[31;42mcolored\x1b[39;49m default");
    expect(segs[0].fg).toBe(1);
    expect(segs[0].bg).toBe(2);
    expect(segs[1].fg).toBeNull();
    expect(segs[1].bg).toBeNull();
  });

  it("256-colour fg (38;5;N)", () => {
    const segs = parseAnsi("\x1b[38;5;196mx");
    expect(segs[0].fg).toBe(196);
  });

  it("256-colour bg (48;5;N)", () => {
    const segs = parseAnsi("\x1b[48;5;21mx");
    expect(segs[0].bg).toBe(21);
  });

  it("truecolor fg (38;2;R;G;B)", () => {
    const segs = parseAnsi("\x1b[38;2;255;128;0mx");
    expect(segs[0].fg).toEqual([255, 128, 0]);
  });

  it("truecolor bg (48;2;R;G;B)", () => {
    const segs = parseAnsi("\x1b[48;2;0;64;255mx");
    expect(segs[0].bg).toEqual([0, 64, 255]);
  });

  it("combined attributes in one sequence", () => {
    const segs = parseAnsi("\x1b[1;3;31mbold italic red\x1b[0m");
    expect(segs[0].bold).toBe(true);
    expect(segs[0].italic).toBe(true);
    expect(segs[0].fg).toBe(1);
  });

  it("multiple style changes produce multiple segments", () => {
    const segs = parseAnsi("\x1b[31mred\x1b[32mgreen\x1b[33myellow");
    expect(segs).toHaveLength(3);
    expect(segs[0].text).toBe("red");
    expect(segs[0].fg).toBe(1);
    expect(segs[1].text).toBe("green");
    expect(segs[1].fg).toBe(2);
    expect(segs[2].text).toBe("yellow");
    expect(segs[2].fg).toBe(3);
  });

  it("text before the first escape is preserved", () => {
    const segs = parseAnsi("plain \x1b[31mred\x1b[0m");
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe("plain ");
    expect(segs[0].fg).toBeNull();
    expect(segs[1].text).toBe("red");
    expect(segs[1].fg).toBe(1);
  });

  it("non-SGR escape sequences are stripped", () => {
    const segs = parseAnsi("\x1b[2J\x1b[Htext");
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("text");
  });

  it("bare reset (\\x1b[m) is treated as \\x1b[0m", () => {
    const segs = parseAnsi("\x1b[31mred\x1b[m normal");
    expect(segs[0].fg).toBe(1);
    expect(segs[1].fg).toBeNull();
  });
});

// --- colorToCss ------------------------------------------------------------

describe("colorToCss", () => {
  it("null → null", () => {
    expect(colorToCss(null)).toBeNull();
  });

  it("standard colour index → hex string", () => {
    expect(colorToCss(0)).toBe("#000000");
    expect(colorToCss(1)).toBe("#cc0000");
  });

  it("256-colour index → rgb string", () => {
    expect(colorToCss(16)).toBe("rgb(0,0,0)");
    expect(colorToCss(255)).toMatch(/^rgb\(/);
  });

  it("truecolor → rgb string", () => {
    expect(colorToCss([255, 128, 0])).toBe("rgb(255,128,0)");
  });
});
