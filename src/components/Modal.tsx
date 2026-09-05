import { useEffect, useRef } from "preact/hooks";
import type { ComponentChild } from "preact";
import { useEscape } from "../lib/keyboard";

interface ModalProps {
  onClose: () => void;
  /** Announced to screen readers as the dialog's name. */
  title: string;
  /** Classes for the panel beyond the base shell — width, height, layout
   * (e.g. `"max-w-md"`, `"flex max-h-[80vh] w-full max-w-3xl flex-col"`). */
  panelClass?: string;
  /** Extra classes for the overlay — e.g. `"z-[60]"` to stack this dialog
   * above another one that is already open. */
  overlayClass?: string;
  /** Whether clicking the backdrop closes the dialog. Default true. Disable
   * for dialogs whose action is destructive enough to demand an explicit
   * choice (the confirmation pattern). */
  dismissable?: boolean;
  /** Panel padding. Default on; dialogs that lay out their own bordered
   * sections (the Store) turn it off. */
  padded?: boolean;
  children: ComponentChild;
}

/** Elements a Tab can land on, in DOM order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The shared modal dialog.
 *
 * Encapsulates everything every overlay in the app owes its users:
 * `role="dialog"` + `aria-modal`, Escape through the keyboard stack, a Tab
 * focus trap, focus moved into the dialog on open and returned to the element
 * that opened it on close, and backdrop-click dismissal.
 *
 * Escape registration is per mounted dialog, so nested dialogs (Show Code over
 * the consent prompt) peel off one at a time — the same stack semantics the
 * app previously hand-wired for each dialog.
 */
export function Modal({
  onClose,
  title,
  panelClass = "max-w-md",
  overlayClass = "",
  dismissable = true,
  padded = true,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  useEscape(true, onClose);

  // Move focus in on open (unless a child already took it via `autoFocus`) and
  // give it back to the opener on close. `document.activeElement` is captured
  // before the dialog can have focus, so the unmount path still restores it.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const panel = panelRef.current;
    const focused = document.activeElement;
    if (
      panel &&
      (!focused ||
        focused === document.body ||
        !panel.contains(focused))
    ) {
      panel.focus();
    }
    return () => {
      const el = previouslyFocused.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus();
    };
  }, []);

  // Tab never leaves the dialog: wrap at the edges, and pull focus back in if
  // it somehow started outside.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      class={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm ${overlayClass}`}
      onClick={dismissable ? onClose : undefined}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        class={`w-full rounded-xl border border-line bg-raised shadow-panel outline-none ${padded ? "p-5" : ""} ${panelClass}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
