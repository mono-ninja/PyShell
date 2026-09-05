import { useCallback, useState } from "preact/hooks";
import type { Preset } from "../types/schema";
import { ipc } from "../lib/ipc";
import { useToast } from "./Toast";
import { useI18n } from "../lib/i18n";
import { Modal } from "./Modal";
import { ContextMenu } from "./ContextMenu";
import { TrashIcon } from "./icons";

interface PresetsBarProps {
  scriptId: string;
  /** Current form values — what "Save" stores under the typed name. */
  values: Record<string, unknown>;
  presets: Preset[];
  activePreset: string | null;
  /** The loaded preset has been edited since loading (dot marker). */
  presetModified: boolean;
  onLoadPreset: (preset: Preset) => void;
  /** A preset was saved under `name` — the caller marks it active. */
  onSaved: (name: string) => void;
  /** A preset was deleted — the caller clears it if it was active. */
  onDeleted: (name: string) => void;
  /** A preset was renamed — the caller follows the new name if it was active. */
  onRenamed: (oldName: string, newName: string) => void;
  /** Re-fetch the script state after a mutation. */
  refreshState: () => Promise<void>;
}

/**
 * The pinned presets bar under the form (Plan.md §M6): load with one click,
 * right-click for rename/delete, type a name to save the current values.
 *
 * Mutations go over IPC here; the caller only learns what changed about the
 * *active* preset, because that is the part it tracks.
 */
export function PresetsBar({
  scriptId,
  values,
  presets,
  activePreset,
  presetModified,
  onLoadPreset,
  onSaved,
  onDeleted,
  onRenamed,
  refreshState,
}: PresetsBarProps) {
  const { t } = useI18n();
  const { notify, notifyError } = useToast();
  const [presetName, setPresetName] = useState("");
  const [presetMenu, setPresetMenu] = useState<{ x: number; y: number; preset: Preset } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleSave = useCallback(async () => {
    const name = presetName.trim();
    if (!name) return;
    try {
      await ipc("save_preset", { scriptId, name, values });
      setPresetName("");
      onSaved(name);
      await refreshState();
    } catch (e) {
      notifyError(e, t("Save preset failed"));
    }
  }, [scriptId, presetName, values, onSaved, refreshState, notifyError, t]);

  const handleDelete = useCallback(async (name: string) => {
    try {
      await ipc("delete_preset", { scriptId, name });
      onDeleted(name);
      await refreshState();
      notify("info", t("Deleted preset \"{name}\"", { name }));
    } catch (e) {
      notifyError(e, t("Delete preset failed"));
    }
  }, [scriptId, onDeleted, refreshState, notify, notifyError, t]);

  const handleRename = useCallback(async (oldName: string, newName: string) => {
    setRenaming(null);
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    try {
      await ipc("rename_preset", { scriptId, oldName, newName: trimmed });
      onRenamed(oldName, trimmed);
      await refreshState();
    } catch (e) {
      notifyError(e, t("Rename preset failed"));
    }
  }, [scriptId, onRenamed, refreshState, notifyError, t]);

  return (
    <>
      <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-line bg-surface px-5 py-2">
        <span class="panel-title mr-1">{t("Presets")}</span>
        {presets.length === 0 && (
          <span class="text-2xs text-subtle">{t("None saved yet")}</span>
        )}
        {presets.map((p) => {
          const isActive = activePreset === p.name;
          return (
            <button
              key={p.name}
              class={`btn py-1 ${isActive ? "btn-primary" : "btn-secondary"}`}
              onClick={() => onLoadPreset(p)}
              onContextMenu={(e) => {
                e.preventDefault();
                setPresetMenu({ x: e.clientX, y: e.clientY, preset: p });
              }}
              title={isActive ? (presetModified ? t("Loaded — modified") : t("Loaded")) : t("Load this preset")}
            >
              {p.name}
              {isActive && presetModified && (
                <span class="ml-1 h-1.5 w-1.5 rounded-full bg-warn" title={t("Modified")} />
              )}
            </button>
          );
        })}
        <div class="ml-auto flex items-center gap-1.5">
          <input
            type="text"
            placeholder={t("New preset…")}
            value={presetName}
            onInput={(e) => setPresetName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && presetName.trim()) handleSave();
            }}
            class="form-input w-36 py-1 text-xs"
          />
          <button
            class="btn btn-primary py-1"
            onClick={handleSave}
            disabled={!presetName.trim()}
          >
            {t("Save")}
          </button>
        </div>
      </div>

      {/* Preset context menu (Plan.md §1.3) */}
      {presetMenu && (
        <ContextMenu
          x={presetMenu.x}
          y={presetMenu.y}
          items={[
            { label: t("Load"), onSelect: () => onLoadPreset(presetMenu.preset) },
            { label: t("Rename…"), onSelect: () => { setRenameValue(presetMenu.preset.name); setRenaming(presetMenu.preset.name); } },
            { label: t("Delete"), separated: true, icon: <TrashIcon size={13} />, onSelect: () => handleDelete(presetMenu.preset.name) },
          ]}
          onClose={() => setPresetMenu(null)}
        />
      )}

      {/* Rename preset dialog */}
      {renaming && (
        <Modal onClose={() => setRenaming(null)} title={t("Rename preset")} panelClass="max-w-sm">
          <h2 class="mb-3 text-[15px] font-semibold">{t("Rename preset")}</h2>
          <input
            type="text"
            class="form-input mb-4"
            value={renameValue}
            autoFocus
            onInput={(e) => setRenameValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename(renaming, renameValue);
            }}
          />
          <div class="flex justify-end gap-2">
            <button class="btn btn-secondary" onClick={() => setRenaming(null)}>{t("Cancel")}</button>
            <button
              class="btn btn-primary"
              onClick={() => handleRename(renaming, renameValue)}
              disabled={!renameValue.trim() || renameValue.trim() === renaming}
            >
              {t("Rename")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
