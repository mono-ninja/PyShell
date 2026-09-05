import { useState, useMemo } from "preact/hooks";
import type { InputSpec } from "../../types/schema";
import { isFieldVisible, validateField } from "./field-utils";
import { StringField } from "./fields/StringField";
import { NumberField } from "./fields/NumberField";
import { BoolField } from "./fields/BoolField";
import { ChoiceField, MultiChoiceField } from "./fields/ChoiceField";
import { FileField, FilesField, DirField, SavePathField } from "./fields/FileField";
import { SecretField } from "./fields/SecretField";
import { ChevronIcon } from "../icons";
import { useI18n } from "../../lib/i18n";

interface FormRendererProps {
  inputs: InputSpec[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  scriptId: string;
}

/** Wide controls read badly in a half-width column. */
const FULL_WIDTH_TYPES = new Set(["multiline", "files", "multi_choice"]);

export function FormRenderer({ inputs, values, onChange, scriptId }: FormRendererProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Group inputs by `group` field (memoized — audit #14)
  const groups = useMemo(() => {
    const map = new Map<string, InputSpec[]>();
    for (const input of inputs) {
      if (!isFieldVisible(input, values)) continue;
      const group = input.group ?? "";
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(input);
    }
    return map;
  }, [inputs, values]);

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  return (
    <div class="border-b border-line bg-surface px-5 py-4">
      <div class="flex flex-col gap-5">
        {Array.from(groups.entries()).map(([group, groupInputs]) => {
          const isDefault = group === "";
          const isCollapsed = collapsedGroups.has(group);

          return (
            <section key={group} class="flex flex-col gap-3">
              {!isDefault && (
                <button
                  type="button"
                  class="group flex items-center gap-1.5 text-left"
                  onClick={() => toggleGroup(group)}
                  aria-expanded={!isCollapsed}
                >
                  <ChevronIcon
                    size={12}
                    class={`text-subtle transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  />
                  <span class="panel-title group-hover:text-muted">{group}</span>
                  <span class="ml-1 h-px flex-1 bg-line" />
                  {isCollapsed && (
                    <span class="text-2xs text-subtle">{groupInputs.length}</span>
                  )}
                </button>
              )}
              {!isCollapsed && (
                <div class="grid grid-cols-1 items-start gap-x-6 gap-y-3.5 lg:grid-cols-2">
                  {groupInputs.map((input) => (
                    <FormField
                      key={input.key}
                      input={input}
                      value={values[input.key]}
                      onChange={(v) => onChange(input.key, v)}
                      scriptId={scriptId}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function FormField({
  input,
  value,
  onChange,
  scriptId,
}: {
  input: InputSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  scriptId: string;
}) {
  const { t } = useI18n();
  const id = `field-${input.key}`;
  const error = validateField(input, value);
  const invalid = error ? "is-invalid" : "";
  const span = FULL_WIDTH_TYPES.has(input.type) ? "lg:col-span-2" : "";

  // A checkbox carries its own label — see BoolField.
  if (input.type === "bool") {
    return (
      <div class={span}>
        <BoolField
          id={id}
          value={value as boolean}
          label={input.label}
          help={input.help}
          onChange={onChange}
        />
      </div>
    );
  }

  const control = () => {
    switch (input.type) {
      case "string":
        return <StringField id={id} value={value as string} onChange={onChange} class={invalid} />;
      case "multiline":
        return <StringField id={id} value={value as string} onChange={onChange} multiline class={invalid} />;
      case "url":
        return <StringField id={id} value={value as string} onChange={onChange} type="url" placeholder="https://example.com" class={invalid} />;
      case "date":
        return <StringField id={id} value={value as string} onChange={onChange} type="date" class={invalid} />;
      case "save_path":
        return <SavePathField value={value as string} defaultName={input.default_name ?? undefined} onChange={onChange} />;
      case "int":
        return <NumberField id={id} value={value as number} onChange={onChange} class={invalid} />;
      case "float":
        return <NumberField id={id} value={value as number} onChange={onChange} step="any" class={invalid} />;
      case "choice":
        return <ChoiceField id={id} value={value as string} options={input.options} onChange={onChange} class={invalid} />;
      case "multi_choice":
        return <MultiChoiceField value={(value as string[]) ?? []} options={input.options} onChange={onChange} />;
      case "file":
        return <FileField value={value as string} extensions={input.extensions} onChange={onChange} />;
      case "files":
        return <FilesField value={(value as string[]) ?? []} extensions={input.extensions} onChange={onChange} />;
      case "dir":
        return <DirField value={value as string} onChange={onChange} />;
      case "secret":
        return <SecretField id={id} scriptId={scriptId} fieldKey={input.key} onChange={onChange} />;
      default:
        return <span class="field-help">{t("Unknown field type")}</span>;
    }
  };

  return (
    <div class={`flex min-w-0 flex-col gap-1.5 ${span}`}>
      <label class="field-label" for={id}>
        {input.label}
        {input.required && <span class="ml-0.5 text-danger">*</span>}
      </label>
      {control()}
      {error ? (
        <span class="field-error">{error}</span>
      ) : (
        input.help && <span class="field-help">{input.help}</span>
      )}
    </div>
  );
}
