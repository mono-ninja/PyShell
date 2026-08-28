interface NumberFieldProps {
  id: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: string;
  class?: string;
}

export function NumberField({ id, value, onChange, step, class: className = "" }: NumberFieldProps) {
  return (
    <input
      id={id}
      type="number"
      step={step}
      class={`form-input ${className}`}
      value={value ?? ""}
      onInput={(e) => {
        const raw = e.currentTarget.value;
        if (raw === "") {
          onChange(null);
          return;
        }
        const n = step ? parseFloat(raw) : parseInt(raw, 10);
        onChange(isNaN(n) ? null : n);
      }}
    />
  );
}
