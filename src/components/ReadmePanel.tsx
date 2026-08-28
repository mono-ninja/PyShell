import { useEffect, useMemo, useRef } from "preact/hooks";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ScriptDoc } from "../types/schema";
import { renderMarkdown } from "../lib/markdown";
import { CloseIcon } from "./icons";
import { useToast } from "./Toast";
import { useEscape } from "../lib/keyboard";

interface ReadmePanelProps {
  doc: ScriptDoc;
  onClose: () => void;
  /** Switch to another translation of the same document. */
  onSelectLang: (lang: string | null) => void;
}

/**
 * Label for a variant tab. The unsuffixed file has no declared language, so it
 * is shown as "Default" rather than guessed at — an author whose base file is
 * Ukrainian would be mislabelled by any assumption of English.
 */
function langLabel(lang: string | null): string {
  return lang === null ? "Default" : lang.toUpperCase();
}

/**
 * Slide-over showing the README that sits next to a script.
 *
 * A drawer rather than a modal: it is reference material you read *while*
 * filling in the form, so it should not take the app hostage. Escape closes it,
 * focus moves in on open and the panel is labelled for screen readers.
 */
export function ReadmePanel({ doc, onClose, onSelectLang }: ReadmePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const body = useMemo(() => renderMarkdown(doc.content), [doc.content]);
  const { notifyError } = useToast();

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Non-modal: the drawer is read while the form behind it is being filled in,
  // so it must not swallow Escape from a dialog on top of it or block the
  // sidebar's arrow keys behind it.
  useEscape(true, onClose, false);

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role="complementary"
      aria-label={`${doc.name} documentation`}
      class="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface outline-none"
    >
      <div class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <span class="panel-title flex-1 truncate" title={doc.path}>
          {doc.name}
        </span>
        <button
          type="button"
          class="btn btn-ghost px-1.5"
          title="Reveal in Finder"
          aria-label="Reveal in Finder"
          onClick={() => revealItemInDir(doc.path).catch((e) => notifyError(e, "Reveal failed"))}
        >
          Reveal
        </button>
        <button
          type="button"
          class="btn btn-ghost px-1.5"
          title="Close (Esc)"
          aria-label="Close documentation"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      {doc.variants.length > 1 && (
        <div
          role="tablist"
          aria-label="Documentation language"
          class="flex shrink-0 gap-1 border-b border-line px-4 py-1.5"
        >
          {doc.variants.map((v) => {
            const active = v.lang === doc.lang;
            return (
              <button
                key={v.lang ?? "\u0000default"}
                type="button"
                role="tab"
                aria-selected={active}
                title={v.name}
                class={`pill ${active ? "bg-accent/15 text-accent" : "text-subtle hover:text-fg"}`}
                onClick={() => onSelectLang(v.lang)}
              >
                {langLabel(v.lang)}
              </button>
            );
          })}
        </div>
      )}
      <div class="flex-1 overflow-y-auto px-4 py-3 text-[13px] text-muted">
        {body.length > 0 ? (
          body
        ) : (
          <p class="text-2xs text-subtle">This file is empty.</p>
        )}
      </div>
    </aside>
  );
}
