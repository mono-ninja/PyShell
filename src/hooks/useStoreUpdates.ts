import { useEffect, useState } from "preact/hooks";
import { ipc } from "../lib/ipc";
import { countUpdates } from "../lib/store-utils";
import type { RepoScript, ScriptEntry } from "../types/schema";

/**
 * How many installed scripts have an update waiting in the Script Store — the
 * dot on the "+ Store" button.
 *
 * Runs a background `repo_catalog` check (cached in Rust with a 5-minute TTL,
 * so this spends GitHub API requests at most once per TTL window) when the
 * app starts and re-derives from the cache whenever the script list changes
 * or the store dialog closes — the dialog's Refresh may have replaced the
 * cache meanwhile.
 *
 * Failures are silent on purpose: an offline or rate-limited background check
 * must not toast at startup. The dialog itself surfaces catalog errors.
 */
export function useStoreUpdates(scripts: ScriptEntry[], storeOpen: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    // While the dialog is open it owns the catalog; re-derive on close.
    if (storeOpen) return;
    let alive = true;
    ipc<RepoScript[]>("repo_catalog", { forceRefresh: false })
      .then((entries) => {
        if (alive) setCount(countUpdates(entries, scripts));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [scripts, storeOpen]);

  return count;
}
