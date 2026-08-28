/**
 * Keyboard plumbing shared by the overlays.
 *
 * Two problems live here. The first is Escape: every dialog wants it, but a
 * plain `window` listener per dialog closes *all* of them at once — Escape in
 * the code viewer would also dismiss the consent dialog underneath it. So
 * overlays register on a stack instead and only the innermost one is closed.
 *
 * The second is that the app binds ArrowUp/ArrowDown globally for sidebar
 * navigation. Those keys belong to whatever is focused first — a text field, a
 * <select>, a dialog — hence `isTypingTarget` and `hasOverlay`.
 */
import { useEffect, useRef } from "preact/hooks";

interface Entry {
  fn: () => void;
  /** Whether this overlay takes the keyboard away from the app behind it. */
  modal: boolean;
}

/** Open overlays, innermost last. */
const stack: Entry[] = [];
let listening = false;

function ensureListener() {
  if (listening) return;
  listening = true;
  // Capture phase: the innermost overlay gets Escape before a field inside it
  // (the history search clears itself on Escape, for instance) can act on it.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || stack.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      stack[stack.length - 1].fn();
    },
    true,
  );
}

/**
 * Close `onEscape` when Escape is pressed and this is the innermost overlay.
 * Pass `active: false` while the overlay is off screen.
 *
 * `modal` marks an overlay that owns the keyboard while it is up (a dialog, a
 * context menu). Pass `false` for something that merely sits alongside the app,
 * such as the docs drawer, so global keys keep working behind it.
 */
export function useEscape(active: boolean, onEscape: () => void, modal = true) {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    ensureListener();
    const entry: Entry = { fn: () => latest.current(), modal };
    stack.push(entry);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i !== -1) stack.splice(i, 1);
    };
  }, [active, modal]);
}

/** True while a modal overlay registered through `useEscape` is on screen. */
export function hasOverlay(): boolean {
  return stack.some((e) => e.modal);
}

/** True if the event target is somewhere text is being entered. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
