import { useEffect, useState } from "preact/hooks";
import { ipc } from "../lib/ipc";
import { useToast } from "../components/Toast";
import type { Artifact, JobEvent } from "../types/schema";

/**
 * Artifacts a finished job produced.
 *
 * Lives above the tab switcher on purpose: if the fetch sat inside the Results
 * pane it would only run once that tab was opened, so the tab could never show
 * a badge telling you there is something to open.
 */
export function useArtifacts(jobId: string | null, exitInfo: JobEvent | null): Artifact[] {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const { notifyError } = useToast();

  useEffect(() => {
    setArtifacts([]);
  }, [jobId]);

  useEffect(() => {
    if (!jobId || exitInfo?.kind !== "exit") return;
    let cancelled = false;
    ipc<Artifact[]>("job_artifacts", { jobId })
      .then((list) => {
        if (!cancelled) setArtifacts(list);
      })
      .catch((e) => notifyError(e, "Could not load artifacts"));
    return () => {
      cancelled = true;
    };
  }, [jobId, exitInfo, notifyError]);

  return artifacts;
}
