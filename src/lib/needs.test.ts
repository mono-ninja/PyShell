import { describe, expect, it } from "vitest";
import { missingNeeds } from "./needs";
import type { ScriptEntry } from "../types/schema";

function script(id: string): ScriptEntry {
  return {
    id,
    name: id,
    icon: null,
    category: null,
    needs: [],
    path: `/tmp/${id}/main.py`,
    source: "yaml",
    reachable: true,
    schema_error: null,
  };
}

describe("missingNeeds", () => {
  it("keeps only needs no installed script carries", () => {
    const missing = missingNeeds(
      ["com.pyshell.sitecrawler", "com.pyshell.curl", "local.gone"],
      [script("com.pyshell.curl")],
    );
    expect(missing).toEqual(["com.pyshell.sitecrawler", "local.gone"]);
  });

  it("is empty when everything is installed or nothing is needed", () => {
    expect(missingNeeds(["a"], [script("a")])).toEqual([]);
    expect(missingNeeds([], [])).toEqual([]);
  });

  it("survives an absent needs field (schemas saved before the feature)", () => {
    // The exact crash this guards against: `undefined is not an object
    // (evaluating 'needs.filter')` on selecting an old script.
    expect(missingNeeds(undefined, [])).toEqual([]);
  });
});
