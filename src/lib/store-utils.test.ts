import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES,
  catalogCategories,
  countUpdates,
  filterByCategory,
  filterByState,
  filterCatalog,
  formatBytes,
  groupCatalog,
  hasUpdate,
  installStateOf,
  installedIds,
  isNewerVersion,
  isUpdatable,
  storeCounts,
} from "./store-utils";
import type { RepoScript, ScriptEntry } from "../types/schema";

function entry(partial: Partial<RepoScript>): RepoScript {
  return {
    dir: "x",
    id: "com.pyshell.x",
    name: "X",
    description: null,
    icon: null,
    category: null,
    version: null,
    needs: [],
    files: 3,
    size_bytes: 1000,
    installed_version: null,
    ...partial,
  };
}

function script(id: string, reachable = true): ScriptEntry {
  return {
    id,
    name: id,
    icon: null,
    category: null,
    needs: [],
    path: `/tmp/${id}/main.py`,
    source: "yaml",
    reachable,
    schema_error: null,
  };
}

describe("filterCatalog", () => {
  const entries = [
    entry({ dir: "bot-hunter", name: "Bot Hunter", description: "log analyzer", category: "SEO" }),
    entry({ dir: "tech-stack", name: "Tech Stack", description: null, category: "Recon" }),
    entry({ dir: "curl", name: "Curl", description: "like curl but python", category: null }),
  ];

  it("returns everything for a blank query", () => {
    expect(filterCatalog(entries, "   ")).toHaveLength(3);
  });

  it("matches the name case-insensitively", () => {
    expect(filterCatalog(entries, "bot").map((e) => e.dir)).toEqual(["bot-hunter"]);
  });

  it("matches the description", () => {
    expect(filterCatalog(entries, "log analyzer").map((e) => e.dir)).toEqual(["bot-hunter"]);
  });

  it("matches the category", () => {
    expect(filterCatalog(entries, "recon").map((e) => e.dir)).toEqual(["tech-stack"]);
  });

  it("matches nothing rather than throwing on punctuation", () => {
    expect(filterCatalog(entries, '"quoted"')).toHaveLength(0);
  });
});

describe("installedIds", () => {
  it("collects ids for the installed badge", () => {
    const ids = installedIds([script("com.pyshell.bothunter"), script("local.abc")]);
    expect(ids.has("com.pyshell.bothunter")).toBe(true);
    expect(ids.has("com.pyshell.curl")).toBe(false);
  });
});

describe("isNewerVersion", () => {
  it("compares component by component, missing components counting as zero", () => {
    expect(isNewerVersion("0.3.9", "0.4")).toBe(true);
    expect(isNewerVersion("0.4", "0.4.0")).toBe(false);
    expect(isNewerVersion("1.2.3", "1.10.0")).toBe(true);
    expect(isNewerVersion("2.0", "1.9.9")).toBe(false);
  });

  it("ignores a leading v and any suffix", () => {
    expect(isNewerVersion("v1.0", "v1.1")).toBe(true);
    expect(isNewerVersion("1.0", "1.1-beta")).toBe(true);
    expect(isNewerVersion("1.0+build7", "1.0")).toBe(false);
  });

  it("treats an unparseable version on either side as not newer", () => {
    expect(isNewerVersion("1.0", "next")).toBe(false);
    expect(isNewerVersion("latest", "2.0")).toBe(false);
    expect(isNewerVersion("", "1.0")).toBe(false);
  });
});

describe("hasUpdate", () => {
  it("is true only when the repo version is strictly newer", () => {
    expect(hasUpdate(entry({ version: "2", installed_version: "1" }))).toBe(true);
    expect(hasUpdate(entry({ version: "0.2.0", installed_version: "0.1.9" }))).toBe(true);
  });

  it("is false when the versions match, written differently or not at all", () => {
    expect(hasUpdate(entry({ version: "1", installed_version: "1" }))).toBe(false);
    expect(hasUpdate(entry({ version: "0.4.0", installed_version: "v0.4" }))).toBe(false);
    expect(hasUpdate(entry({ version: null, installed_version: null }))).toBe(false);
  });

  it("never offers a downgrade", () => {
    // The author republished an older version, or the repo folder was rolled
    // back. Repair re-downloads it on purpose; Update must not suggest it.
    expect(hasUpdate(entry({ version: "1", installed_version: "2" }))).toBe(false);
  });

  it("is false when either side has no version — different is not newer", () => {
    // Repo gained a version where the installed copy had none, and the other
    // way round. Neither is a version comparison, so neither is an update; the
    // row stays Installed and Repair covers re-downloading it.
    expect(hasUpdate(entry({ version: "2", installed_version: null }))).toBe(false);
    expect(hasUpdate(entry({ version: null, installed_version: "1" }))).toBe(false);
  });

  it("does not offer an update for an *absent* installed_version", () => {
    // `skip_serializing_if` makes the field absent over IPC, not null, so a row
    // fetched while the script was still uninstalled carries `undefined`. That
    // used to read as an update and made a freshly installed row offer one for
    // the files it had just downloaded; a version comparison cannot.
    const stale: RepoScript = { ...entry({ version: "1" }), installed_version: undefined };
    expect(hasUpdate(stale)).toBe(false);
  });
});

describe("countUpdates", () => {
  it("counts only installed scripts with a strictly newer repo version", () => {
    const entries = [
      entry({ id: "a", version: "2", installed_version: "1" }), // update
      entry({ id: "b", version: "1", installed_version: "1" }), // current
      entry({ id: "c", version: "9", installed_version: null }), // not installed
      entry({ id: "d", version: "3", installed_version: "2" }), // update
    ];
    const scripts = [script("a"), script("b"), script("d")];
    expect(countUpdates(entries, scripts)).toBe(2);
  });

  it("is zero for an empty catalog or no installs", () => {
    expect(countUpdates([], [script("a")])).toBe(0);
    expect(countUpdates([entry({ id: "a", version: "2" })], [])).toBe(0);
  });

  it("does not count scripts whose folder is gone — they cannot be updated", () => {
    const entries = [entry({ id: "a", version: "2", installed_version: "1" })];
    expect(countUpdates(entries, [script("a", false)])).toBe(0);
    expect(countUpdates(entries, [script("a", true)])).toBe(1);
  });
});

describe("installStateOf", () => {
  it("separates not-installed, healthy and broken installs", () => {
    const e = entry({ id: "a" });
    expect(installStateOf(e, [])).toBe("installable");
    expect(installStateOf(e, [script("a")])).toBe("installed");
    expect(installStateOf(e, [script("a", false)])).toBe("unreachable");
    // A different script's id does not match.
    expect(installStateOf(e, [script("b")])).toBe("installable");
  });
});

describe("groupCatalog", () => {
  const seo = entry({ dir: "a", id: "a", category: "SEO" });
  const media = entry({ dir: "b", id: "b", category: "Media" });
  const recon = entry({ dir: "c", id: "c", category: "recon" });
  const loose1 = entry({ dir: "d", id: "d", category: null });
  const loose2 = entry({ dir: "e", id: "e", category: "" });

  it("sorts categories A→Z case-insensitively, uncategorised last", () => {
    const sections = groupCatalog([seo, loose1, media, recon, loose2]);
    expect(sections.map((s) => s.label)).toEqual(["Media", "recon", "SEO", "Other"]);
    expect(sections[3].items.map((e) => e.dir)).toEqual(["d", "e"]);
  });

  it("merges the uncategorised tail into a real Other category", () => {
    const other = entry({ dir: "f", id: "f", category: "Other" });
    const sections = groupCatalog([seo, other, loose1]);
    expect(sections.map((s) => s.label)).toEqual(["Other", "SEO"]);
    expect(sections[0].items.map((e) => e.dir)).toEqual(["f", "d"]);
  });

  it("returns no Other section when everything is categorised", () => {
    const sections = groupCatalog([seo, media]);
    expect(sections.map((s) => s.label)).toEqual(["Media", "SEO"]);
  });
});

describe("formatBytes", () => {
  it("scales to KB and MB", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(34 * 1024 * 1024)).toBe("34 MB");
  });

  it("keeps sub-kilobyte sizes in bytes and whole KB without decimals", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1280)).toBe("1 KB");
  });
});

describe("filterByState", () => {
  const entries = [
    entry({ dir: "a", id: "a", version: "2", installed_version: "1" }), // update
    entry({ dir: "b", id: "b", version: "1", installed_version: "1" }), // current
    entry({ dir: "c", id: "c" }), // not installed
    entry({ dir: "d", id: "d", version: "2", installed_version: "1" }), // gone
  ];
  const scripts = [script("a"), script("b"), script("d", false)];

  it("passes everything through for \"all\"", () => {
    expect(filterByState(entries, scripts, "all")).toHaveLength(4);
  });

  it("keeps every imported script, unreachable ones included", () => {
    expect(filterByState(entries, scripts, "installed").map((e) => e.dir)).toEqual(["a", "b", "d"]);
  });

  it("keeps only rows the Update button would offer", () => {
    // "d" has a newer version but its folder is gone — the row shows Missing
    // folder instead of Update, so the filter must not promise one either.
    expect(filterByState(entries, scripts, "updates").map((e) => e.dir)).toEqual(["a"]);
  });

  it("agrees with isUpdatable and countUpdates", () => {
    expect(filterByState(entries, scripts, "updates").every((e) => isUpdatable(e, scripts))).toBe(true);
    expect(filterByState(entries, scripts, "updates")).toHaveLength(countUpdates(entries, scripts));
  });

  it("is empty when nothing is installed", () => {
    expect(filterByState(entries, [], "installed")).toEqual([]);
    expect(filterByState(entries, [], "updates")).toEqual([]);
  });
});

describe("storeCounts", () => {
  it("counts each filter the way the filter itself does", () => {
    const entries = [
      entry({ dir: "a", id: "a", version: "2", installed_version: "1" }),
      entry({ dir: "b", id: "b", version: "1", installed_version: "1" }),
      entry({ dir: "c", id: "c" }),
      entry({ dir: "d", id: "d", version: "2", installed_version: "1" }),
    ];
    const scripts = [script("a"), script("b"), script("d", false)];
    expect(storeCounts(entries, scripts)).toEqual({ all: 4, installed: 3, updates: 1 });
    for (const f of ["all", "installed", "updates"] as const) {
      expect(filterByState(entries, scripts, f)).toHaveLength(storeCounts(entries, scripts)[f]);
    }
  });

  it("is all zeroes for an empty catalog", () => {
    expect(storeCounts([], [script("a")])).toEqual({ all: 0, installed: 0, updates: 0 });
  });
});

describe("catalogCategories", () => {
  const entries = [
    entry({ dir: "a", category: "SEO" }),
    entry({ dir: "b", category: "Recon" }),
    entry({ dir: "c", category: null }),
    entry({ dir: "d", category: "SEO" }),
  ];

  it("lists the categories in the order the list renders them, with counts", () => {
    expect(catalogCategories(entries)).toEqual([
      { key: "Recon", label: "Recon", count: 1 },
      { key: "SEO", label: "SEO", count: 2 },
      { key: "\u0000other", label: "Other", count: 1 },
    ]);
  });

  it("agrees with the sections the list groups into", () => {
    const sections = groupCatalog(entries);
    expect(catalogCategories(entries).map((c) => c.key)).toEqual(sections.map((s) => s.key));
    expect(catalogCategories(entries).map((c) => c.count)).toEqual(
      sections.map((s) => s.items.length),
    );
  });

  it("is empty for an empty catalog", () => {
    expect(catalogCategories([])).toEqual([]);
  });
});

describe("filterByCategory", () => {
  const entries = [
    entry({ dir: "a", category: "SEO" }),
    entry({ dir: "b", category: "Recon" }),
    entry({ dir: "c", category: null }),
    entry({ dir: "d", category: "Other" }),
  ];

  it("passes everything through for the all-categories key", () => {
    expect(filterByCategory(entries, ALL_CATEGORIES)).toHaveLength(4);
  });

  it("keeps only the chosen category", () => {
    expect(filterByCategory(entries, "SEO").map((e) => e.dir)).toEqual(["a"]);
  });

  it("merges uncategorised scripts into a declared \"Other\", like the sections do", () => {
    expect(filterByCategory(entries, "Other").map((e) => e.dir)).toEqual(["d", "c"]);
  });

  it("yields nothing for a category that left the catalog", () => {
    expect(filterByCategory(entries, "Gone")).toEqual([]);
  });
});
