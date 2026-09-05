import type { ChoiceOption } from "../../../types/schema";

import { useI18n } from "../../../lib/i18n";
interface ChoiceFieldProps {
  id: string;
  value: string | null;
  options: ChoiceOption[];
  onChange: (v: string) => void;
  class?: string;
}

export function ChoiceField({ id, value, options, onChange, class: className = "" }: ChoiceFieldProps) {
  return (
    <select
      id={id}
      class={`form-input ${className}`}
      value={value ?? ""}
      onChange={(e) => onChange(e.currentTarget.value)}
    >
      <option value="" disabled hidden>
        Choose…
      </option>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label ?? opt.value}
        </option>
      ))}
    </select>
  );
}

interface MultiChoiceFieldProps {
  value: string[];
  options: ChoiceOption[];
  onChange: (v: string[]) => void;
}

export function MultiChoiceField({ value, options, onChange }: MultiChoiceFieldProps) {
  const { t } = useI18n();
  const arr = value ?? [];
  const allSelected = arr.length === options.length && options.length > 0;

  return (
    <div class="rounded-md border border-line bg-raised">
      <div class="flex items-center justify-between border-b border-line px-2.5 py-1.5">
        <span class="text-2xs text-subtle">
          {t("{n} of {m} selected", { n: arr.length, m: options.length })}
        </span>
        <button
          type="button"
          class="text-2xs font-medium text-accent hover:underline"
          onClick={() => onChange(allSelected ? [] : options.map((o) => o.value))}
        >
          {allSelected ? t("Clear all") : t("Select all")}
        </button>
      </div>
      <div class="flex max-h-40 flex-col overflow-y-auto p-1">
        {options.map((opt) => (
          <label
            key={opt.value}
            class="row-hover flex cursor-pointer select-none items-center gap-2 rounded px-1.5 py-1 text-[13px]"
          >
            <input
              type="checkbox"
              checked={arr.includes(opt.value)}
              onChange={(e) => {
                if (e.currentTarget.checked) {
                  if (!arr.includes(opt.value)) onChange([...arr, opt.value]);
                } else {
                  onChange(arr.filter((v) => v !== opt.value));
                }
              }}
            />
            <span class="truncate">{opt.label ?? opt.value}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
