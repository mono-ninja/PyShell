import { useEffect, useRef } from "preact/hooks";
import { listen } from "@tauri-apps/api/event";

/** Must match `MENU_EVENT` in src-tauri/src/menu.rs. */
export const MENU_EVENT = "menu:action";

/**
 * Run `handler` when a native menu item is chosen (by click or by its keyboard
 * shortcut). The menu owns every app shortcut — see src-tauri/src/menu.rs for
 * why the webview must not bind them a second time.
 *
 * The listener is registered once and reads the handler through a ref: `listen`
 * resolves asynchronously, so re-subscribing on every render would leave two
 * listeners overlapping for a moment and double-fire toggles like Docs.
 */
export function useMenuAction(handler: (action: string) => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>(MENU_EVENT, (e) => latest.current(e.payload)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
