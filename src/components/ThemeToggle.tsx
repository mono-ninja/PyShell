import type { Theme } from "../hooks/useTheme";
import { useI18n } from "../lib/i18n";

interface ThemeToggleProps {
  theme: Theme;
  onChange: (t: Theme) => void;
}

/** Segmented light / dark / system control. */
export function ThemeToggle({ theme, onChange }: ThemeToggleProps) {
  const { t } = useI18n();
  const options: { value: Theme; label: string; icon: string }[] = [
    { value: "light", label: t("Light"), icon: "☀" },
    { value: "dark", label: t("Dark"), icon: "☾" },
    { value: "system", label: t("Match system"), icon: "◐" },
  ];
  return (
    <div class="flex items-center gap-2">
      <span class="panel-title flex-1">{t("Theme")}</span>
      <div
        class="flex items-center gap-0.5 rounded-md bg-fg/[0.06] p-0.5"
        role="radiogroup"
        aria-label={t("Colour theme")}
      >
        {options.map((opt) => {
          const active = theme === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              title={opt.label}
              class={`rounded px-2 py-[3px] text-[12px] leading-none transition-colors ${
                active
                  ? "bg-raised text-fg shadow-sm"
                  : "text-subtle hover:text-fg"
              }`}
              onClick={() => onChange(opt.value)}
            >
              {opt.icon}
            </button>
          );
        })}
      </div>
    </div>
  );
}
