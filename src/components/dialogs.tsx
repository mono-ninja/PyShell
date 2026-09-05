import type { ScriptSource } from "../types/schema";
import { useI18n } from "../lib/i18n";
import { Modal } from "./Modal";
import { CloseIcon } from "./icons";

/**
 * The small confirm/info dialogs of the script view, on the shared [`Modal`]
 * (role/aria, Escape, focus trap, focus return). Each is a thin shell: the
 * state that decides whether to show them, and the actions, stay with the
 * caller.
 */

export function ConsentDialog({
  onShowCode,
  onClose,
  onConfirm,
}: {
  onShowCode: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal onClose={onClose} title={t("Run Introspection?")}>
      <h2 class="mb-1.5 text-[15px] font-semibold">{t("Run Introspection?")}</h2>
      <p class="mb-4 text-[13px] leading-relaxed text-muted">
        {t("PyShell will execute this script to detect its arguments. This runs all code at the module top-level — imports, function definitions, and any code outside if __name__. A 10-second timeout is enforced. No secrets are passed.")}
      </p>
      <div class="flex justify-between gap-2">
        <button
          class="btn btn-secondary px-3 py-1.5"
          onClick={onShowCode}
        >
          {t("Show Code")}
        </button>
        <div class="flex gap-2">
          <button
            class="btn btn-secondary px-3 py-1.5"
            onClick={onClose}
          >
            {t("Cancel")}
          </button>
          <button
            class="btn btn-primary px-3 py-1.5"
            onClick={onConfirm}
          >
            {t("Run Introspection")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function CodeDialog({ source, onClose }: { source: ScriptSource; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal
      onClose={onClose}
      title={t("Script Code")}
      // Above the consent dialog it opens from, and taller than the default.
      overlayClass="z-[60]"
      panelClass="mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col"
    >
      <div class="mb-3 flex items-center justify-between">
        <h2 class="truncate text-lg font-semibold" title={source.path}>{source.name}</h2>
        <button class="btn btn-ghost" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <pre class="flex-1 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed">
        {source.content}
      </pre>
      <p class="mt-2 text-2xs text-subtle">
        {t("This is the code that will be executed during introspection. Review it before proceeding.")}
      </p>
    </Modal>
  );
}

export function DepsConfirmDialog({
  deps,
  onClose,
  onInstall,
}: {
  deps: string[];
  onClose: () => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal onClose={onClose} title={t("Install Dependencies?")} panelClass="max-w-lg">
      <h2 class="mb-1.5 text-[15px] font-semibold">{t("Install Dependencies?")}</h2>
      <p class="mb-3 text-[13px] leading-relaxed text-muted">
        {t("The following packages will be installed in an isolated virtual environment:")}
      </p>
      <div class="mb-4 max-h-48 overflow-y-auto rounded-lg border border-line bg-surface p-2">
        {deps.map((dep) => (
          <div key={dep} class="text-sm font-mono">{dep}</div>
        ))}
      </div>
      <p class="mb-4 text-2xs text-subtle">
        {t("Only pre-built wheels are used when available. Building from source (sdist) is supported as fallback for Python 3.13+.")}
      </p>
      <div class="flex justify-end gap-2">
        <button
          class="btn btn-secondary px-3 py-1.5"
          onClick={onClose}
        >
          {t("Cancel")}
        </button>
        <button class="btn btn-run px-3 py-1.5" autoFocus onClick={onInstall}>
          {t("Install")}
        </button>
      </div>
    </Modal>
  );
}

export function OnboardingDialog({
  onDismiss,
  onBrowseStore,
}: {
  onDismiss: () => void;
  onBrowseStore: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal onClose={onDismiss} title={t("Welcome to PyShell")}>
      <h2 class="mb-2 text-[15px] font-semibold">{t("Welcome to PyShell")}</h2>
      <p class="mb-3 text-[13px] leading-relaxed text-muted">
        {t("PyShell runs Python scripts in isolated virtual environments. To prepare environments and install dependencies, the app needs network access to download Python interpreters and packages via uv.")}
      </p>
      <p class="mb-3 text-[13px] leading-relaxed text-muted">
        {t("Scripts run locally on your machine with full system access (no sandbox). Import only scripts you trust.")}
      </p>
      <p class="mb-4 text-[13px] leading-relaxed text-muted">
        {t("Need something to run? The + Store button in the sidebar installs ready-made scripts from the community repo.")}
      </p>
      <div class="flex justify-end gap-2">
        <button
          class="btn btn-secondary px-3 py-1.5"
          onClick={onBrowseStore}
        >
          {t("Browse the Store")}
        </button>
        <button class="btn btn-primary px-3 py-1.5" autoFocus onClick={onDismiss}>
          {t("Got it")}
        </button>
      </div>
    </Modal>
  );
}

export function CancelConfirmDialog({
  onKeepRunning,
  onCancelRun,
}: {
  onKeepRunning: () => void;
  onCancelRun: () => void;
}) {
  const { t } = useI18n();
  return (
    // Destructive enough to demand an explicit choice: the backdrop does not
    // close it.
    <Modal onClose={onKeepRunning} title={t("Cancel this run?")} panelClass="max-w-sm" dismissable={false}>
      <h2 class="mb-1.5 text-[15px] font-semibold">{t("Cancel this run?")}</h2>
      <p class="mb-4 text-[13px] leading-relaxed text-muted">
        {t("The script and all its child processes will be killed immediately. Any partial output is kept in the log.")}
      </p>
      <div class="flex justify-end gap-2">
        <button class="btn btn-secondary" autoFocus onClick={onKeepRunning}>
          {t("Keep running")}
        </button>
        <button class="btn btn-danger" onClick={onCancelRun}>
          {t("Cancel run")}
        </button>
      </div>
    </Modal>
  );
}
