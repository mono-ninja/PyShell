import type { JSX } from "preact";
import { useI18n } from "../lib/i18n";

export interface TabDef<Id extends string> {
  id: Id;
  label: string;
  /** Small count or marker shown after the label. */
  badge?: string | number | null;
  /** Draws an unread dot — for content that arrived while the tab was hidden. */
  dot?: boolean;
}

interface TabsProps<Id extends string> {
  tabs: TabDef<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
  /** Rendered at the right end of the bar, e.g. per-tab controls. */
  children?: JSX.Element | JSX.Element[] | null;
}

/**
 * Tab bar for the run panes.
 *
 * A real `tablist`: arrow keys move between tabs, Home/End jump to the ends, and
 * each tab points at its panel. Buttons alone would leave the whole pane
 * switcher unreachable without a mouse.
 */
export function Tabs<Id extends string>({ tabs, active, onSelect, children }: TabsProps<Id>) {
  const { t } = useI18n();
  const move = (delta: number) => {
    const i = tabs.findIndex((t) => t.id === active);
    if (i < 0) return;
    const next = (i + delta + tabs.length) % tabs.length;
    onSelect(tabs[next].id);
  };

  return (
    <div class="flex shrink-0 items-center gap-1 border-b border-line px-3">
      <div
        role="tablist"
        aria-label={t("Run panes")}
        class="flex items-center gap-0.5"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Home") {
            e.preventDefault();
            onSelect(tabs[0].id);
          } else if (e.key === "End") {
            e.preventDefault();
            onSelect(tabs[tabs.length - 1].id);
          }
        }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              // Only the active tab is in the tab order; arrows move within.
              tabIndex={selected ? 0 : -1}
              class={`relative -mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] transition-colors ${
                selected
                  ? "border-accent font-medium text-fg"
                  : "border-transparent text-muted hover:text-fg"
              }`}
              onClick={() => onSelect(tab.id)}
            >
              {tab.label}
              {tab.badge != null && tab.badge !== "" && (
                <span
                  class={`rounded-full px-1.5 py-px text-2xs tabular-nums ${
                    selected ? "bg-accent/15 text-accent" : "bg-fg/[0.07] text-subtle"
                  }`}
                >
                  {tab.badge}
                </span>
              )}
              {tab.dot && !selected && (
                <span
                  class="absolute right-1 top-1.5 h-1.5 w-1.5 rounded-full bg-accent"
                  aria-label={t("new content")}
                />
              )}
            </button>
          );
        })}
      </div>
      {children && <div class="ml-auto flex items-center gap-1.5 py-1">{children}</div>}
    </div>
  );
}
