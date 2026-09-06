import { describe, expect, it } from "vitest";
import { normalizeTableRows } from "./table-rows";

describe("normalizeTableRows", () => {
  const columns = ["crawler", "operator", "verdict"];

  it("passes array rows through with their values", () => {
    expect(
      normalizeTableRows(columns, [
        ["GPTBot", "OpenAI", "blocked"],
        ["ClaudeBot", "Anthropic", "allowed"],
      ]),
    ).toEqual([
      ["GPTBot", "OpenAI", "blocked"],
      ["ClaudeBot", "Anthropic", "allowed"],
    ]);
  });

  it("reads a dict row by column name (legacy tolerance)", () => {
    expect(
      normalizeTableRows(columns, [
        { crawler: "GPTBot", operator: "OpenAI", verdict: "blocked" },
      ]),
    ).toEqual([["GPTBot", "OpenAI", "blocked"]]);
  });

  it("maps a missing or null cell in a dict row to an empty string", () => {
    expect(
      normalizeTableRows(columns, [{ crawler: "CCBot", verdict: null }]),
    ).toEqual([["CCBot", "", ""]]);
  });

  it("tolerates rows that is not an array at all", () => {
    expect(normalizeTableRows(columns, undefined)).toEqual([]);
    expect(normalizeTableRows(columns, "nope" as unknown as unknown[])).toEqual([]);
  });

  it("degrades a non-array, non-object row to empty cells instead of crashing", () => {
    expect(normalizeTableRows(columns, [42 as unknown])).toEqual([["", "", ""]]);
  });
});
