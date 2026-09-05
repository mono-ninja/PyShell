import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ipc } from "../lib/ipc";
import type {
  EnvStatus,
  ScriptDoc,
  ScriptSchema,
  ScriptState,
} from "../types/schema";
import type { ToastApi } from "../components/Toast";
import { useI18n } from "../lib/i18n";

/**
 * The selected script and everything that is loaded for it.
 *
 * `selectScript` is race-safe: a token is bumped on every call and every
 * async step checks it before committing state, so quickly clicking two
 * scripts cannot let the slower fetch of the first overwrite the second
 * (audit H7). `selectedIdRef` mirrors `selectedId` for the places that must
 * read the current selection from inside a callback that closed over an older
 * one (audit #8).
 */
export function useSelectedScript(notifyError: ToastApi["notifyError"]) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [schema, setSchema] = useState<ScriptSchema | null>(null);
  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [scriptState, setScriptState] = useState<ScriptState | null>(null);
  const [readme, setReadme] = useState<ScriptDoc | null>(null);

  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const selectTokenRef = useRef(0);

  const selectScript = useCallback(
    async (id: string) => {
      const token = ++selectTokenRef.current;
      setSelectedId(id);
      setSchema(null);
      setEnvStatus(null);
      setValues({});
      setScriptState(null);
      setReadme(null);
      try {
        const s = await ipc<ScriptSchema>("get_schema", { scriptId: id });
        if (selectTokenRef.current !== token) return; // stale
        setSchema(s);
        const defaults: Record<string, unknown> = {};
        for (const input of s.inputs) {
          if (input.default !== undefined && input.default !== null) {
            defaults[input.key] = input.default;
          }
        }
        setValues(defaults);
        const status = await ipc<EnvStatus>("env_status", { scriptId: id });
        if (selectTokenRef.current !== token) return; // stale
        setEnvStatus(status);
        const state = await ipc<ScriptState>("get_state", { scriptId: id });
        if (selectTokenRef.current !== token) return; // stale
        setScriptState(state);
        // Best-effort: a script with no README is the common case, and a failure
        // here must not stop the form from loading.
        ipc<ScriptDoc | null>("script_readme", { scriptId: id })
          .then((doc) => {
            if (selectTokenRef.current === token) setReadme(doc);
          })
          .catch((e) => notifyError(e, t("Readme load failed")));
        if (state.last_values && Object.keys(state.last_values).length > 0) {
          // Filter last_values to only keys present in current schema (audit M11)
          const validKeys = new Set(s.inputs.map((i) => i.key));
          const filtered = Object.fromEntries(
            Object.entries(state.last_values).filter(([k]) => validKeys.has(k)),
          );
          setValues({ ...defaults, ...filtered });
        }
      } catch (e) {
        notifyError(e, t("Failed to load script"));
      }
    },
    [notifyError, t],
  );

  /** Drop the selection if it is `id` — the script-removal path. */
  const clearIfSelected = useCallback((id: string) => {
    if (selectedIdRef.current !== id) return;
    setSelectedId(null);
    setSchema(null);
    setEnvStatus(null);
    setValues({});
    setScriptState(null);
    setReadme(null);
    ++selectTokenRef.current; // any in-flight select for it is now stale
  }, []);

  /** Re-fetch the same document in another language. The backend falls back
   * to the default variant if the code no longer resolves, so a deleted
   * translation degrades to the default rather than blanking the panel. */
  const selectReadmeLang = useCallback(
    (lang: string | null) => {
      const id = selectedIdRef.current;
      if (!id) return;
      ipc<ScriptDoc | null>("script_readme", { scriptId: id, lang })
        .then((doc) => setReadme(doc))
        .catch((e) => notifyError(e, t("Readme load failed")));
    },
    [notifyError, t],
  );

  return {
    selectedId,
    setSelectedId,
    selectedIdRef,
    schema,
    setSchema,
    envStatus,
    setEnvStatus,
    values,
    setValues,
    scriptState,
    setScriptState,
    readme,
    setReadme,
    selectScript,
    clearIfSelected,
    selectReadmeLang,
  };
}
