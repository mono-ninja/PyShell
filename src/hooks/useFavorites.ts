import { useCallback, useEffect, useState } from "preact/hooks";
import { ipc } from "../lib/ipc";
import type { ScriptEntry } from "../types/schema";

/**
 * Pinned scripts, in the order that decides ⌘1…⌘9.
 *
 * The list lives in Rust (`store::favorites`), which also owns the native
 * Favorites submenu — so re-reading it after every script list change is not
 * just for the sidebar: that call is what refreshes a pinned script's name in
 * the menu after a manifest edit.
 */
export function useFavorites(scripts: ScriptEntry[], onError: (e: unknown, prefix: string) => void) {
  const [favorites, setFavorites] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setFavorites(await ipc<string[]>("list_favorites"));
    } catch (e) {
      onError(e, "Could not read favorites");
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [scripts, refresh]);

  const toggleFavorite = useCallback(
    async (scriptId: string) => {
      try {
        setFavorites(await ipc<string[]>("toggle_favorite", { scriptId }));
      } catch (e) {
        onError(e, "Could not update favorites");
      }
    },
    [onError],
  );

  return { favorites, toggleFavorite, refresh };
}
