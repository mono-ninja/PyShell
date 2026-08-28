interface StringFieldProps {
  id: string;
  value: string | null;
  onChange: (v: string) => void;
  multiline?: boolean;
  type?: "text" | "url" | "date";
  placeholder?: string;
  class?: string;
}

export function StringField({
  id,
  value,
  onChange,
  multiline,
  type = "text",
  placeholder,
  class: className = "",
}: StringFieldProps) {
  if (multiline) {
    return (
      <textarea
        id={id}
        class={`form-input font-mono text-xs ${className}`}
        rows={5}
        placeholder={placeholder}
        value={value ?? ""}
        onInput={(e) => onChange(e.currentTarget.value)}
      />
    );
  }
  return (
    <input
      id={id}
      type={type}
      class={`form-input ${className}`}
      placeholder={placeholder}
      value={value ?? ""}
      onInput={(e) => onChange(e.currentTarget.value)}
    />
  );
}
