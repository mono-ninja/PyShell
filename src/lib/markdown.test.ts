import { describe, it, expect } from "vitest";
import { isSafeHref, splitRow } from "./markdown";

// --- isSafeHref ------------------------------------------------------------
//
// This is security-sensitive logic (Plan.md §1.7): the README is untrusted
// input, and this webview can invoke Tauri commands. `javascript:` and other
// executable schemes must never survive here — CSP is a backstop, not the
// primary defence.

describe("isSafeHref", () => {
  it("allows http", () => {
    expect(isSafeHref("http://example.com")).toBe(true);
  });

  it("allows https", () => {
    expect(isSafeHref("https://example.com/path?q=1")).toBe(true);
  });

  it("allows mailto", () => {
    expect(isSafeHref("mailto:user@example.com")).toBe(true);
  });

  it("rejects javascript:", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
  });

  it("rejects data:", () => {
    expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects relative anchor", () => {
    expect(isSafeHref("#section")).toBe(false);
  });

  it("rejects absolute path", () => {
    expect(isSafeHref("/etc/passwd")).toBe(false);
  });

  it("rejects relative path", () => {
    expect(isSafeHref("./secret.txt")).toBe(false);
  });

  it("rejects protocol-relative URL", () => {
    expect(isSafeHref("//evil.com/x")).toBe(false);
  });

  it("rejects vbscript:", () => {
    expect(isSafeHref("vbscript:msgbox(1)")).toBe(false);
  });

  it("rejects file:", () => {
    expect(isSafeHref("file:///etc/passwd")).toBe(false);
  });

  it("trims whitespace before checking", () => {
    expect(isSafeHref("  https://example.com  ")).toBe(true);
    expect(isSafeHref("  javascript:alert(1)  ")).toBe(false);
  });

  it("is case-insensitive for scheme", () => {
    expect(isSafeHref("HTTPS://example.com")).toBe(true);
    expect(isSafeHref("HTTP://example.com")).toBe(true);
    expect(isSafeHref("MAILTO:user@example.com")).toBe(true);
  });
});

// --- splitRow --------------------------------------------------------------

describe("splitRow", () => {
  it("splits a simple pipe row", () => {
    expect(splitRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });

  it("splits without leading/trailing pipes", () => {
    expect(splitRow("a | b | c")).toEqual(["a", "b", "c"]);
  });

  it("trims cell content", () => {
    expect(splitRow("|  spaced  |  cells  |")).toEqual(["spaced", "cells"]);
  });

  it("handles single column", () => {
    expect(splitRow("| only |")).toEqual(["only"]);
  });

  it("handles empty cells", () => {
    expect(splitRow("| a |  | c |")).toEqual(["a", "", "c"]);
  });

  it("handles pipes inside content conservatively (splits on all pipes)", () => {
    // This is expected behaviour: pipe tables don't support escaped pipes
    // in this minimal renderer.
    expect(splitRow("| a\\|b | c |")).toEqual(["a\\", "b", "c"]);
  });
});
