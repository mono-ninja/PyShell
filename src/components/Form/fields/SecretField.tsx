import { useState, useEffect } from "preact/hooks";
import { ipc } from "../../../lib/ipc";
import { CloseIcon, LockIcon } from "../../icons";

export const SECRET_SET_SENTINEL = "__secret_set__";

interface SecretFieldProps {
  id: string;
  scriptId: string;
  fieldKey: string;
  onChange: (v: string) => void;
}

export function SecretField({ id, scriptId, fieldKey, onChange }: SecretFieldProps) {
  const [hasSecret, setHasSecret] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if secret already exists (audit C2: useEffect, not useState)
  useEffect(() => {
    let cancelled = false;
    setError(null);
    ipc<boolean>("has_secret", { scriptId, key: fieldKey })
      .then((v) => { if (!cancelled) setHasSecret(v); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [scriptId, fieldKey]);

  const handleSave = async () => {
    if (!value) return;
    setSaving(true);
    setError(null);
    try {
      await ipc("set_secret", { scriptId, key: fieldKey, value });
      onChange(SECRET_SET_SENTINEL);
      setHasSecret(true);
      setEditing(false);
      setValue("");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    setError(null);
    try {
      await ipc("delete_secret", { scriptId, key: fieldKey });
      setHasSecret(false);
      onChange("");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (hasSecret && !editing) {
    return (
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center gap-1.5">
          <span class="form-picker min-w-0 flex-1" title="Stored in the system keychain">
            <LockIcon class="text-subtle" />
            <span class="flex-1 tracking-[0.2em] text-muted">••••••••</span>
            <span class="shrink-0 text-2xs text-subtle">Saved</span>
          </span>
          <button type="button" class="btn btn-secondary" onClick={() => setEditing(true)}>
            Change
          </button>
          <button
            type="button"
            class="btn btn-ghost hover:text-danger"
            onClick={handleDelete}
            disabled={saving}
            title="Delete from keychain"
            aria-label="Delete secret from keychain"
          >
            <CloseIcon size={12} />
          </button>
        </div>
        {error && <span class="field-error">{error}</span>}
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-1.5">
        <input
          id={id}
          type="password"
          class="form-input flex-1"
          placeholder="Enter secret value"
          value={value}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value && !saving) handleSave();
          }}
        />
        <button
          type="button"
          class="btn btn-primary"
          onClick={handleSave}
          disabled={saving || !value}
        >
          {saving ? "…" : "Save"}
        </button>
        {hasSecret && (
          <button type="button" class="btn btn-ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
      <span class="field-help">Stored in the system keychain, passed to the script as an env var.</span>
      {error && <span class="field-error">{error}</span>}
    </div>
  );
}
