import { useState } from "preact/hooks";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CloseIcon, FileIcon, FolderIcon, SaveIcon } from "../../icons";

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
        {!value && <span class="shrink-0 text-2xs text-subtle">Browse…</span>}
      </button>
      {value && onClear && (
        <button
          type="button"
          class="btn btn-ghost px-1.5"
          title="Clear"
          aria-label="Clear selection"
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
  return (
    <Picker
      icon={<FileIcon />}
      value={value ? basename(value) : null}
      title={value ?? undefined}
      placeholder="No file selected"
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
  const arr = value ?? [];

  return (
    <div class="flex flex-col gap-1.5">
      <Picker
        icon={<FileIcon />}
        value={arr.length > 0 ? `${arr.length} file${arr.length === 1 ? "" : "s"} selected` : null}
        placeholder="No files selected"
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
                title="Remove"
                aria-label={`Remove ${basename(p)}`}
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
  return (
    <Picker
      icon={<FolderIcon />}
      value={value ? basename(value) : null}
      title={value ?? undefined}
      placeholder="No folder selected"
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
  return (
    <Picker
      icon={<SaveIcon />}
      value={value ? basename(value) : null}
      title={value ?? undefined}
      placeholder={defaultName ? `Save as ${defaultName}` : "Choose where to save"}
      onPick={async () => {
        const result = await save({ defaultPath: defaultName });
        if (result && typeof result === "string") onChange(result);
      }}
      onClear={() => onChange("")}
    />
  );
}
