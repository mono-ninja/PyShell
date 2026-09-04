import type { RepoScript, ScriptEntry } from "../types/schema";

/**
 * Pure helpers for the Script Store dialog. Kept free of Preact/IPC so they
 * can be tested under Vitest's node environment, the way the rest of the
 * repo tests pure logic instead of rendering.
 */

/** Case- and accent-insensitive match on name, description or category, so
 * "seo" finds both "SEO Checks" and "Sécurité" without listing everything.
 * Generic so a narrowed entry type (e.g. the dialog's needs-normalized
 * `StoreEntry`) survives the filter. */
export function filterCatalog<T extends RepoScript>(entries: T[], query: string): T[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    [e.name, e.description ?? "", e.category ?? ""]
      .join("\n")
      .toLocaleLowerCase()
      .includes(q),
  );
}

/** Ids of the imported scripts — a store entry with a matching manifest id is
 * already installed and gets the badge instead of an Install button. */
export function installedIds(scripts: ScriptEntry[]): Set<string> {
  return new Set(scripts.map((s) => s.id));
}

/**
 * The repo carries a different version than the installed script. Either side
 * may declare no version at all — then any difference still counts, since a
 * repo that gained (or dropped) a version changed something.
 *
 * Only meaningful for entries whose id is in `installedIds` — the dialog calls
 * this after that check.
 */
export function hasUpdate(e: RepoScript): boolean {
  return e.version !== e.installed_version;
}

/** How many installed scripts have a newer version in the catalog — drives
 * the dot on the "+ Store" button. Scripts whose folder is gone do not count:
 * they cannot be updated until relinked, and a dot promising an update that
 * the row then refuses to offer is a lie. */
export function countUpdates(entries: RepoScript[], scripts: ScriptEntry[]): number {
  return entries.filter((e) => installStateOf(e, scripts) === "installed" && hasUpdate(e)).length;
}

/** A store row's state relative to the local script list. */
export type InstallState = "installable" | "installed" | "unreachable";

/**
 * "unreachable" — the id matches an imported script whose entry says the file
 * is gone. The row must not claim a healthy install, and Update is pointless
 * (the backend would refuse: nothing to swap), so it renders a warn pill
 * pointing at the sidebar's Find/relink flow instead.
 */
export function installStateOf(e: RepoScript, scripts: ScriptEntry[]): InstallState {
  const s = scripts.find((x) => x.id === e.id);
  if (!s) return "installable";
  return s.reachable ? "installed" : "unreachable";
}

/** One category section of the store list. */
export interface CatalogSection<T extends RepoScript = RepoScript> {
  /** Stable key for the section; `OTHER_KEY` for the uncategorised tail. */
  key: string;
  label: string;
  items: T[];
}

/** Key for the uncategorised tail — U+0000 cannot collide with a category
 * coming from a manifest (same trick as the sidebar's sections). */
const OTHER_KEY = "\u0000other";

/**
 * Group catalog entries by category, mirroring how the sidebar groups
 * imported scripts: named categories A→Z (case-insensitive), uncategorised
 * scripts last under "Other" — merged into a real "Other" category when one
 * exists, so the two never render as twin headers. Generic so the dialog's
 * needs-normalized entry type survives.
 */
export function groupCatalog<T extends RepoScript>(entries: T[]): CatalogSection<T>[] {
  const byCategory = new Map<string, T[]>();
  const loose: T[] = [];
  for (const e of entries) {
    const cat = e.category?.trim();
    if (cat) {
      const list = byCategory.get(cat);
      if (list) list.push(e);
      else byCategory.set(cat, [e]);
    } else {
      loose.push(e);
    }
  }

  const sections: CatalogSection<T>[] = [...byCategory.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }))
    .map(([label, items]) => ({ key: label, label, items }));

  if (loose.length > 0) {
    // A manifest may already declare a category called "Other"; merging into
    // it beats rendering two sections under the same heading.
    const existing = sections.find(
      (s) => s.label.toLocaleLowerCase() === "other",
    );
    if (existing) existing.items = [...existing.items, ...loose];
    else sections.push({ key: OTHER_KEY, label: "Other", items: loose });
  }
  return sections;
}

/** "1.2 KB" / "3.4 MB" — one decimal only where it carries information. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
