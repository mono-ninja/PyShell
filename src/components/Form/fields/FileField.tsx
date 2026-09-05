import { useState } from "preact/hooks";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CloseIcon, FileIcon, FolderIcon, SaveIcon } from "../../icons";
import { useI18n } from "../../../lib/i18n";

/** Show the file name, not the whole path — the full path lives in the tooltip. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

interface PickerProps {
  icon: preact.ComponentChildren;
  value: string | null;
  placeholder: string;
  title?: string;
  onPick: () => void | Promise<void>;
  onDropText?: (text: string) => void;
  onClear?: () => void;
}

/**
 * Shared shell for the file/dir/save pickers. They look like fields but behave
 * like buttons, so they get their own affordance rather than borrowing
 * `.form-input`, which would suggest the text is editable.
 */
function Picker({ icon, value, placeholder, title, onPick, onDropText, onClear }: PickerProps) {
  const { t } = useI18n();
  const [dragOver, setDragOver] = useState(false);

  return (
    <div class="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        class={`form-picker min-w-0 ${value ? "" : "is-empty"} ${dragOver ? "is-drop-target" : ""}`}
        title={title ?? value ?? undefined}
        onClick={onPick}
        onDragOver={
          onDropText &&
          ((e: DragEvent) => {
            e.preventDefault();
            setDragOver(true);
          })
        }
        onDragLeave={onDropText && (() => setDragOver(false))}
        onDrop={
          onDropText &&
          ((e: DragEvent) => {
            e.preventDefault();
            setDragOver(false);
            const text = e.dataTransfer?.getData("text/plain");
            if (text) onDropText(text);
          })
        }
      >
        <span class="shrink-0 text-subtle">{icon}</span>
        <span class="flex-1 truncate">{value ?? placeholder}</span>
        {!value && <span class="shrink-0 text-2xs text-subtle">{t("Browse…")}</span>}
      </button>
      {value && onClear && (
        <button
          type="button"
          class="btn btn-ghost px-1.5"
          title={t("Clear")}
          aria-label={t("Clear selection")}
          onClick={onClear}
        >
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );
}

interface FileFieldProps {
  value: string | null;
  extensions: string[];
  onChange: (v: string) => void;
}

export function FileField({ value, extensions, onChange }: FileFieldProps) {
  const { t } = useI18n();
  return (
    <Picker
      icon={<FileIcon />}
      value={value ? basename(value) : null}
      title={value ?? undefined}
      placeholder={t("No file selected")}
      onPick={async () => {
        const result = await open({
          multiple: false,
          filters: extensions.length ? [{ name: "Files", extensions }] : undefined,
        });
        if (result && typeof result === "string") onChange(result);
      }}
      onDropText={onChange}
      onClear={() => onChange("")}
    />
  );
}

interface FilesFieldProps {
  value: string[];
  extensions: string[];
  onChange: (v: string[]) => void;
}

export function FilesField({ value, extensions, onChange }: FilesFieldProps) {
  const { t } = useI18n();
  const arr = value ?? [];

  return (
    <div class="flex flex-col gap-1.5">
      <Picker
        icon={<FileIcon />}
        value={arr.length > 0 ? t("{n} files selected", { n: arr.length }) : null}
        placeholder={t("No files selected")}
        onPick={async () => {
          const result = await open({
            multiple: true,
            filters: extensions.length ? [{ name: "Files", extensions }] : undefined,
          });
          if (result && Array.isArray(result)) onChange(result);
        }}
        onDropText={(text) => onChange([...arr, text])}
        onClear={() => onChange([])}
      />
      {arr.length > 0 && (
        <ul class="flex flex-col gap-0.5 rounded-md border border-line bg-raised p-1">
          {arr.map((p) => (
            <li
              key={p}
              class="row-hover flex items-center gap-1.5 rounded px-1.5 py-0.5 text-2xs text-muted"
              title={p}
            >
              <span class="flex-1 truncate">{basename(p)}</span>
              <button
                type="button"
                class="shrink-0 text-subtle hover:text-danger"
                title={t("Remove")}
                aria-label={t("Remove {name}", { name: basename(p) })}
                onClick={() => onChange(arr.filter((x) => x !== p))}
              >
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface DirFieldProps {
  value: string | null;
  onChange: (v: string) => void;
}

export function DirField({ value, onChange }: DirFieldProps) {
  const { t } = useI18n();
  return (
    <Picker
      icon={<FolderIcon />}
      value={value ? basename(value) : null}
      title={value ?? undefined}
      placeholder={t("No folder selected")}
      onPick={async () => {
        const result = await open({ directory: true });
        if (result && typeof result === "string") onChange(result);
      }}
      onDropText={onChange}
      onClear={() => onChange("")}
    />
  );
}

interface SavePathFieldProps {
  value: string | null;
  defaultName: string | undefined;
  onChange: (v: string) => void;
}

export function SavePathField({ value, defaultName, onChange }: SavePathFieldProps) {
  const { t } = useI18n();
  return (
    <Picker
      icon={<SaveIcon />}
      value={value ? basename(value) : null}
      title={value ?? undefined}
      placeholder={defaultName ? t("Save as {name}", { name: defaultName }) : t("Choose where to save")}
      onPick={async () => {
        const result = await save({ defaultPath: defaultName });
        if (result && typeof result === "string") onChange(result);
      }}
      onClear={() => onChange("")}
    />
  );
}
