import { CloseIcon } from "./icons";
import { renderMarkdown, ExternalLink } from "../lib/markdown";
import { SCRIPTING_GUIDE } from "../lib/scripting-guide";
import { SCRIPTS_URL } from "../lib/links";
import { useI18n } from "../lib/i18n";
import { Modal } from "./Modal";

/**
 * Help → How to Write a Script.
 *
 * The guide is Markdown run through the same subset renderer as script
 * READMEs, so it inherits that styling and the no-`dangerouslySetInnerHTML`
 * guarantee. Scrolls internally; the shared [`Modal`] provides the backdrop,
 * Escape, focus handling and the dialog semantics.
 */
export function ScriptingGuide({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal
      onClose={onClose}
      title={t("How to Write a Script")}
      overlayClass="z-[60]"
      panelClass="mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col"
      padded={false}
    >
      <div class="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 class="text-lg font-semibold">{t("How to Write a Script")}</h2>
        <button type="button" class="btn btn-ghost" onClick={onClose} aria-label={t("Close")}>
          <CloseIcon />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-5 py-4">{renderMarkdown(SCRIPTING_GUIDE)}</div>

      <div class="border-t border-line px-5 py-3 text-2xs text-subtle">
        {t("Ready-made scripts to import and learn from:")}{" "}
        <ExternalLink href={SCRIPTS_URL}>PyShell-scripts</ExternalLink>
      </div>
    </Modal>
  );
}
