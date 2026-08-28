interface BoolFieldProps {
  id: string;
  value: boolean | null;
  label: string;
  help?: string | null;
  onChange: (v: boolean) => void;
}

/**
 * A checkbox owns its own label, unlike every other field type: a caption
 * stranded above a checkbox reads as a heading rather than as the thing the box
 * toggles. `FormRenderer` therefore skips its usual label for `bool`.
 */
export function BoolField({ id, value, label, help, onChange }: BoolFieldProps) {
  return (
    <label class="group flex cursor-pointer select-none items-start gap-2.5 py-1" for={id}>
      <input
        id={id}
        type="checkbox"
        class="mt-[3px] shrink-0"
        checked={value ?? false}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="text-[13px] leading-tight text-fg">{label}</span>
        {help && <span class="field-help">{help}</span>}
      </span>
    </label>
  );
}
