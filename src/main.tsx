import { render } from "preact";
import { Component } from "preact";
import { App } from "./app";
import { ToastProvider } from "./components/Toast";
import { I18nProvider } from "./lib/i18n";
import "./index.css";

/**
 * Re-apply the theme class the same way `useTheme` does. The crash screen is
 * rendered when the tree below died — possibly before `useTheme` ever ran —
 * so it cannot rely on the class being there and must not hardcode colours
 * either: this is the one screen users see at the worst moment, and it should
 * at least be *their* worst moment in the right theme.
 */
function applyThemeForCrashScreen(): void {
  let theme = "system";
  try {
    theme = localStorage.getItem("pyshell.theme") ?? "system";
  } catch {
    // Storage unavailable — follow the OS.
  }
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

class ErrorBoundary extends Component<{ children: preact.ComponentChildren }, { hasError: boolean; error: string }> {
  constructor(props: { children: preact.ComponentChildren }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, error: String(error) };
  }

  componentDidCatch(error: unknown) {
    console.error("Uncaught error:", error);
    applyThemeForCrashScreen();
  }

  render() {
    if (this.state.hasError) {
      return (
        // Semantic tokens, not raw colours: the screen follows light/dark the
        // same way the rest of the app does.
        <div class="flex h-screen w-screen items-center justify-center bg-app px-8 text-center text-fg">
          <div class="max-w-md">
            <h1 class="mb-2 text-[17px] font-semibold tracking-tight">Something went wrong</h1>
            <p class="mb-4 break-words font-mono text-xs leading-relaxed text-muted">{this.state.error}</p>
            <button
              type="button"
              class="btn btn-primary"
              onClick={() => { this.setState({ hasError: false, error: "" }); window.location.reload(); }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("app");
if (!root) throw new Error("Root element #app not found");
render(
  <ErrorBoundary>
    <I18nProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </I18nProvider>
  </ErrorBoundary>,
  root,
);
