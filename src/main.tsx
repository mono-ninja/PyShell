import { render } from "preact";
import { Component } from "preact";
import { App } from "./app";
import { ToastProvider } from "./components/Toast";
import "./index.css";

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
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", textAlign: "center", fontFamily: "sans-serif" }}>
          <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>Something went wrong</h1>
          <p style={{ color: "#666", fontSize: "0.875rem", marginBottom: "1rem" }}>{this.state.error}</p>
          <button
            type="button"
            onClick={() => { this.setState({ hasError: false, error: "" }); window.location.reload(); }}
            style={{ padding: "0.5rem 1rem", background: "#3b82f6", color: "white", border: "none", borderRadius: "0.25rem", cursor: "pointer" }}
          >
            Reload
          </button>
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
    <ToastProvider>
      <App />
    </ToastProvider>
  </ErrorBoundary>,
  root,
);
