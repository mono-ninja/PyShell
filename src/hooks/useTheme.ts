import { useCallback, useEffect, useState } from "preact/hooks";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "pyshell.theme";
const THEMES: Theme[] = ["light", "dark", "system"];

function readStored(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (THEMES as string[]).includes(raw)) return raw as Theme;
  } catch {
    // Private mode / storage disabled — fall back to following the OS.
  }
  return "system";
}

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(theme: Theme): boolean {
  const dark = theme === "dark" || (theme === "system" && prefersDark());
  // Tailwind is configured with darkMode: "class", so this single class drives
  // every `dark:` variant as well as the token block in index.css.
  document.documentElement.classList.toggle("dark", dark);
  return dark;
}

/**
 * Theme state, persisted per user.
 *
 * "system" is resolved here rather than left to a CSS media query: with both in
 * play an explicit choice could not override the OS setting.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readStored);
  const [isDark, setIsDark] = useState<boolean>(() => apply(readStored()));

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    setIsDark(apply(next));
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisting is survivable; the theme still applies for this session.
    }
  }, []);

  // Follow the OS while on "system".
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setIsDark(apply("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme, isDark };
}
