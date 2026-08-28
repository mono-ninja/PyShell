import { useEffect, useState, useCallback } from "preact/hooks";
import { ipc } from "../lib/ipc";
import { useToast } from "../components/Toast";
import type { ScriptEntry } from "../types/schema";

export function useScripts() {
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { notifyError } = useToast();

  const refresh = useCallback(async () => {
    try {
      const list = await ipc<ScriptEntry[]>("list_scripts");
      setScripts(list);
    } catch (e) {
      notifyError(e, "Could not load scripts");
    } finally {
      setLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { scripts, loading, refresh };
}
