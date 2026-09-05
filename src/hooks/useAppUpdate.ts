import { useCallback, useEffect, useState } from "preact/hooks";
import { ipc } from "../lib/ipc";
import type { AppRelease } from "../types/schema";

export interface AppUpdate {
  /** The newer release to offer, or null while none is known. */
  release: AppRelease | null;
  /** A check is in flight — the Settings button shows it. */
  checking: boolean;
  /**
   * Ask GitHub (or the Rust-side cache) whether a newer PyShell exists, and
   * return what it said. `force` skips the cache, which is what the menu's
   * "Check for Updates…" does. Throws on a network or rate-limit failure, so
   * a manual check can report it — the background one swallows it instead.
   */
  check: (force: boolean) => Promise<AppRelease | null>;
}

/**
 * Whether a newer PyShell has been published.
 *
 * A notice, not an updater: `release.url` is the GitHub release page, which
 * the user opens to download the .dmg themselves. Auto-install would need an
 * updater signing key and a `latest.json` the release pipeline does not build.
 *
 * The startup check is silent on failure, for the same reason `useStoreUpdates`
 * is: an offline launch must not open with an error toast. Nothing is shown
 * unless there is genuinely something newer to point at.
 */
export function useAppUpdate(): AppUpdate {
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async (force: boolean): Promise<AppRelease | null> => {
    setChecking(true);
    try {
      const found = await ipc<AppRelease | null>("check_app_update", { force });
      setRelease(found);
      return found;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check(false).catch(() => {});
  }, [check]);

  return { release, checking, check };
}
