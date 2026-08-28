import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useEscape } from "../lib/keyboard";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: preact.ComponentChildren;
  /** Draws a separator above this item. */
  separated?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * Right-click menu, positioned at the cursor.
 *
 * Rendered fixed and flipped back inside the viewport when it would overflow —
 * a right-click near the bottom of the sidebar would otherwise open a menu half
 * off-screen. Escape, click-outside and arrow keys all work, so the menu is not
 * a mouse-only affordance.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);

  // Measure, then nudge back on-screen before the first paint the user sees.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      x: Math.min(x, window.innerWidth - width - margin),
      y: Math.min(y, window.innerHeight - height - margin),
    });
  }, [x, y]);

  // Escape goes through the shared stack, so it closes the menu even when the
  // menu itself lost focus, and only the innermost overlay reacts.
  useEscape(true, onClose);

  useEffect(() => {
    ref.current?.focus();

    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Any scroll or resize invalidates the anchor point.
    const onDismiss = () => onClose();

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
    };
  }, [onClose]);

  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const move = (delta: number) => {
    if (!enabled.length) return;
    const at = enabled.indexOf(active);
    const next = at < 0 ? (delta > 0 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
    setActive(enabled[next]);
  };

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  };

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      class="fixed z-[60] min-w-[220px] overflow-hidden rounded-lg border border-line bg-raised py-1 shadow-panel outline-none"
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Enter" && active >= 0) {
          e.preventDefault();
          choose(items[active]);
        }
      }}
      // The menu is opened by a right-click; don't let a second one stack menus.
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={item.label}>
          {item.separated && <div class="my-1 h-px bg-line" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            class={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors disabled:opacity-40 ${
              i === active ? "bg-accent text-white" : "text-fg hover:bg-fg/[0.07]"
            }`}
            onMouseEnter={() => setActive(item.disabled ? -1 : i)}
            onClick={() => choose(item)}
          >
            {item.icon && (
              <span class={i === active ? "text-white" : "text-subtle"}>{item.icon}</span>
            )}
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
