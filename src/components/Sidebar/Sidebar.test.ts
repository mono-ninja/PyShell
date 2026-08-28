import { describe, it, expect } from "vitest";
import { buildSections } from "./Sidebar";
import type { ScriptEntry } from "../../types/schema";

function entry(name: string, category: string | null): ScriptEntry {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    icon: null,
    category,
    path: `/tmp/${name}.py`,
    source: "yaml",
    reachable: true,
    schema_error: null,
  } as ScriptEntry;
}

/** What the sidebar actually renders, top to bottom. */
const layout = (scripts: ScriptEntry[], sortAlpha: boolean, favorites: string[] = []) =>
  buildSections(scripts, sortAlpha, favorites).map((s) => [
    s.header ? s.label : "(no header)",
    ...s.items.map((i) => i.name),
  ]);

describe("buildSections", () => {
  it("keeps import order and trails loose scripts with no header", () => {
    const scripts = [
      entry("NinjaScan", "Security"),
      entry("IP → Domains Finder", "Recon"),
      entry("Report Demo", null),
    ];
    expect(layout(scripts, false)).toEqual([
      ["Security", "NinjaScan"],
      ["Recon", "IP → Domains Finder"],
      ["(no header)", "Report Demo"],
    ]);
  });

  it("sorts loose scripts into the order as Other", () => {
    // The reported case: one script per category, so sorting only shows up if
    // the uncategorised bucket stops being pinned to the bottom.
    const scripts = [
      entry("IP → Domains Finder", "Recon"),
      entry("NinjaScan", "Security"),
      entry("Report Demo", null),
    ];
    expect(layout(scripts, true)).toEqual([
      ["Other", "Report Demo"],
      ["Recon", "IP → Domains Finder"],
      ["Security", "NinjaScan"],
    ]);
  });

  it("orders sections by label, case-insensitively", () => {
    const scripts = [
      entry("z", "zeta"),
      entry("a", "Alpha"),
      entry("m", "beta"),
    ];
    expect(buildSections(scripts, true).map((s) => s.label)).toEqual(["Alpha", "beta", "zeta"]);
  });

  it("merges loose scripts into a manifest-declared Other category", () => {
    const scripts = [
      entry("Declared", "Other"),
      entry("Loose", null),
      entry("Scanner", "Security"),
    ];
    const sections = buildSections(scripts, true);
    expect(sections.map((s) => s.label)).toEqual(["Other", "Security"]);
    // Merged and re-sorted, not appended as a second section with the same name.
    expect(sections[0].items.map((i) => i.name)).toEqual(["Declared", "Loose"]);
  });

  it("matches a declared Other regardless of case", () => {
    const sections = buildSections([entry("Declared", "OTHER"), entry("Loose", null)], true);
    expect(sections).toHaveLength(1);
    expect(sections[0].items.map((i) => i.name)).toEqual(["Declared", "Loose"]);
  });

  it("gives the uncategorised section a key that no category can collide with", () => {
    const sections = buildSections([entry("Loose", null)], true);
    expect(sections[0].key).toBe("\u0000ungrouped");
    expect(sections[0].header).toBe(true);
  });

  it("emits no section for an empty list, and none when nothing is loose", () => {
    expect(buildSections([], false)).toEqual([]);
    expect(buildSections([], true)).toEqual([]);
    const grouped = [entry("A", "One"), entry("B", "Two")];
    expect(buildSections(grouped, true).every((s) => s.header)).toBe(true);
    expect(buildSections(grouped, true)).toHaveLength(2);
  });

  it("keeps every script exactly once, whichever way it is ordered", () => {
    const scripts = [
      entry("d", null), entry("b", "Two"), entry("a", "One"),
      entry("c", "Two"), entry("e", null), entry("f", "One"),
    ];
    for (const sortAlpha of [false, true]) {
      const names = buildSections(scripts, sortAlpha).flatMap((s) => s.items.map((i) => i.name));
      expect(names.slice().sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    }
  });

  it("pins favorites on top, in their own order, out of their categories", () => {
    const scripts = [
      entry("Alpha", "Recon"),
      entry("Beta", "Security"),
      entry("Gamma", null),
    ];
    // Pin order is the shortcut order: Gamma is ⌘1 even though it is last.
    expect(layout(scripts, false, ["gamma", "alpha"])).toEqual([
      ["Favorites", "Gamma", "Alpha"],
      ["Security", "Beta"],
    ]);
  });

  it("keeps the pinned order when the list is sorted A→Z", () => {
    // Sorting must not renumber ⌘1/⌘2 under the user.
    const scripts = [entry("Alpha", "Recon"), entry("Beta", "Recon")];
    expect(layout(scripts, true, ["beta", "alpha"])).toEqual([
      ["Favorites", "Beta", "Alpha"],
    ]);
  });

  it("drops a category that has nothing left once its scripts are pinned", () => {
    const scripts = [entry("Only", "Recon"), entry("Other", "Security")];
    expect(layout(scripts, false, ["only"])).toEqual([
      ["Favorites", "Only"],
      ["Security", "Other"],
    ]);
  });

  it("ignores pinned ids with no matching script", () => {
    // A stale id (removed script, or one filtered out by the search box) must
    // not create an empty section or shift the rest.
    const scripts = [entry("Alpha", "Recon")];
    expect(layout(scripts, false, ["ghost", "alpha"])).toEqual([
      ["Favorites", "Alpha"],
    ]);
    expect(layout(scripts, false, ["ghost"])).toEqual([["Recon", "Alpha"]]);
  });

  it("gives the favorites section a key no category can collide with", () => {
    const sections = buildSections([entry("A", "One")], false, ["a"]);
    expect(sections[0].key).toBe("\u0000favorites");
    expect(sections[0].header).toBe(true);
  });

  it("still lists every script exactly once when some are pinned", () => {
    const scripts = [
      entry("a", "One"), entry("b", "Two"), entry("c", null),
      entry("d", "One"), entry("e", null),
    ];
    for (const sortAlpha of [false, true]) {
      const names = buildSections(scripts, sortAlpha, ["c", "a"]).flatMap((s) =>
        s.items.map((i) => i.name),
      );
      expect(names.slice().sort()).toEqual(["a", "b", "c", "d", "e"]);
    }
  });

  it("preserves the order it was handed inside a section", () => {
    // The component sorts the flat list first; sections must not reshuffle it.
    const scripts = [entry("a", "One"), entry("b", "One"), entry("c", "One")];
    expect(buildSections(scripts, true)[0].items.map((i) => i.name)).toEqual(["a", "b", "c"]);
  });
});
