import { CloseIcon } from "./icons";
import { renderMarkdown, ExternalLink } from "../lib/markdown";
import { SCRIPTING_GUIDE } from "../lib/scripting-guide";
import { SCRIPTS_URL } from "../lib/links";

/**
 * Help → How to Write a Script.
 *
 * The guide is Markdown run through the same subset renderer as script
 * READMEs, so it inherits that styling and the no-`dangerouslySetInnerHTML`
 * guarantee. Scrolls internally; the backdrop and Escape both close it
 * (Escape is registered by the caller through `useEscape`).
 */
export function ScriptingGuide({ onClose }: { onClose: () => void }) {
  return (
    <div
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        class="mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-line bg-raised shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 class="text-lg font-semibold">How to Write a Script</h2>
          <button type="button" class="btn btn-ghost" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-5 py-4">{renderMarkdown(SCRIPTING_GUIDE)}</div>

        <div class="border-t border-line px-5 py-3 text-2xs text-subtle">
          Ready-made scripts to import and learn from:{" "}
          <ExternalLink href={SCRIPTS_URL}>PyShell-scripts</ExternalLink>
        </div>
      </div>
    </div>
  );
}
