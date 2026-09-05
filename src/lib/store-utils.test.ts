import { describe, expect, it } from "vitest";
import {
  countUpdates,
  filterCatalog,
  formatBytes,
  groupCatalog,
  hasUpdate,
  installStateOf,
  installedIds,
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

describe("hasUpdate", () => {
  it("is false when the versions match, including both missing", () => {
    expect(hasUpdate(entry({ version: "1", installed_version: "1" }))).toBe(false);
    expect(hasUpdate(entry({ version: null, installed_version: null }))).toBe(false);
  });

  it("is true when the repo version differs from the installed one", () => {
    expect(hasUpdate(entry({ version: "2", installed_version: "1" }))).toBe(true);
    // Repo gained a version where the installed copy had none.
    expect(hasUpdate(entry({ version: "2", installed_version: null }))).toBe(true);
    // Repo dropped a version the installed copy still has.
    expect(hasUpdate(entry({ version: null, installed_version: "1" }))).toBe(true);
  });

  it("reads an *absent* installed_version as an update — the shape a stale row has", () => {
    // `skip_serializing_if` makes the field absent over IPC, not null, so a row
    // fetched while the script was still uninstalled carries `undefined`. This
    // is correct here and is exactly why StoreDialog re-reads the catalog after
    // an install: left stale, the row would offer an Update for the files it
    // had just downloaded. Fix the staleness, never this comparison.
    const stale: RepoScript = { ...entry({ version: "1" }), installed_version: undefined };
    expect(hasUpdate(stale)).toBe(true);
  });
});

describe("countUpdates", () => {
  it("counts only installed scripts whose repo version differs", () => {
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
