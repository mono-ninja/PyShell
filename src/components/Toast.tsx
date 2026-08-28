import { createContext } from "preact";
import { useContext, useState, useEffect, useCallback } from "preact/hooks";
import type { JSX } from "preact";
import { CloseIcon } from "./icons";

export interface ToastMessage {
  text: string;
  kind: "info" | "error";
}

interface ToastApi {
  /** Show a toast of the given kind with `text`. */
  notify: (kind: ToastMessage["kind"], text: string) => void;
  /** Show an error toast, deriving the message from anything caught. */
  notifyError: (e: unknown, prefix?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

interface ToastProps {
  message: ToastMessage | null;
  onDismiss: () => void;
}

/**
 * Transient feedback for actions with no other visible result.
 *
 * "Path copied" and "PyCharm not found" both need saying: without this the
 * context menu would look like it did nothing at all. Errors stay until
 * dismissed — a failure the user misses is a failure they cannot act on.
 */
export function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!message || message.kind === "error") return;
    const t = setTimeout(onDismiss, 2600);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  if (!message) return null;
  const isError = message.kind === "error";

  return (
    <div
      role="status"
      aria-live="polite"
      class="pointer-events-none fixed inset-x-0 bottom-5 z-[70] flex justify-center px-6"
    >
      <div
        class={`pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px] shadow-panel ${
          isError
            ? "border-danger/30 bg-raised text-danger"
            : "border-line bg-raised text-fg"
        }`}
      >
        <span class="min-w-0 flex-1 leading-snug">{message.text}</span>
        <button
          type="button"
          class="shrink-0 pt-0.5 text-subtle transition-colors hover:text-fg"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <CloseIcon size={12} />
        </button>
      </div>
    </div>
  );
}

/**
 * Owns the single toast slot for the whole app.
 *
 * Lifted to the root so every `catch` can surface a message the user actually
 * sees — in a release build the devtools console is gone, so a `console.error`
 * is the same as silence.
 */
export function ToastProvider({ children }: { children: JSX.Element | JSX.Element[] }) {
  const [message, setMessage] = useState<ToastMessage | null>(null);

  const notify = useCallback<ToastApi["notify"]>((kind, text) => {
    setMessage({ kind, text });
  }, []);

  const notifyError = useCallback<ToastApi["notifyError"]>((e, prefix) => {
    const msg = e instanceof Error ? e.message : String(e);
    setMessage({ kind: "error", text: prefix ? `${prefix}: ${msg}` : msg });
  }, []);

  return (
    <ToastContext.Provider value={{ notify, notifyError }}>
      {children}
      <Toast message={message} onDismiss={() => setMessage(null)} />
    </ToastContext.Provider>
  );
}
