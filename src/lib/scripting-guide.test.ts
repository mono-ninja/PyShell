import { describe, it, expect } from "vitest";
import { SCRIPTING_GUIDE } from "./scripting-guide";
import { renderMarkdown } from "./markdown";

/**
 * The guide is a template literal, so a stray backtick or `${` would either
 * fail to compile or silently truncate the text. These pin the content that
 * the Help menu actually shows.
 */
describe("scripting guide", () => {
  it("is substantial and complete to the last section", () => {
    expect(SCRIPTING_GUIDE.length).toBeGreaterThan(6000);
    expect(SCRIPTING_GUIDE).toContain("# Writing a PyShell script");
    expect(SCRIPTING_GUIDE.trimEnd().endsWith("```")).toBe(true);
  });

  it("has balanced code fences", () => {
    const fences = SCRIPTING_GUIDE.match(/^```/gm) ?? [];
    expect(fences.length % 2).toBe(0);
  });

  it("covers every documented area", () => {
    for (const heading of [
      "## Project layout",
      "## Three ways to describe a script",
      "## The manifest",
      "## Introspection",
      "## Field types",
      "## Bindings — how a value reaches the script",
      "## Conditional fields",
      "## Grouping",
      "## Secrets",
      "## Reporting progress",
      "## Files and results",
      "## Dependencies",
      "## Documenting it for the operator",
      "## A complete example",
    ]) {
      expect(SCRIPTING_GUIDE).toContain(heading);
    }
  });

  it("states the rules that are easy to get wrong", () => {
    expect(SCRIPTING_GUIDE).toContain("0–100, not 0–1");
    expect(SCRIPTING_GUIDE).toContain("output cap as log lines");
    expect(SCRIPTING_GUIDE).toContain("may only bind to");
  });

  it("keeps python escapes intact rather than real newlines", () => {
    // `\n` inside the python samples must survive as two characters.
    expect(SCRIPTING_GUIDE).toContain('f.write("name,value\\nalpha,1\\n")');
  });

  it("renders through the app's own Markdown renderer", () => {
    const nodes = renderMarkdown(SCRIPTING_GUIDE);
    expect(nodes.length).toBeGreaterThan(40);
  });
});
