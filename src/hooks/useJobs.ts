import { useState, useCallback, useRef, useMemo } from "preact/hooks";
import { Channel } from "@tauri-apps/api/core";
import { ipc } from "../lib/ipc";
import { useToast } from "../components/Toast";
import type { JobEvent, LogLine } from "../types/schema";

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartData {
  chartType: "line" | "bar";
  title: string | null;
  labels: string[];
  series: ChartSeries[];
}

export interface StructuredState {
  progress: { pct: number; message: string } | null;
  table: { columns: string[]; rows: unknown[][] } | null;
  status: string | null;
  markdown: string | null;
  chart: ChartData | null;
}

export interface JobState {
  jobId: string | null;
  lines: LogLine[];
  running: boolean;
  exitInfo: JobEvent | null;
  structured: StructuredState;
  logFilePath: string | null;
}

type JobsMap = Record<string, JobState>;

const MAX_LINES = 500_000;
const HEAD_KEEP = 250_000;
const TAIL_KEEP = 250_000;

function emptyJobState(): JobState {
  return {
    jobId: null,
    lines: [],
    running: false,
    exitInfo: null,
    structured: { progress: null, table: null, status: null, markdown: null, chart: null },
    logFilePath: null,
  };
}

export function useJobs() {
  const [jobs, setJobs] = useState<JobsMap>({});
  const channelsRef = useRef<Map<string, Channel<JobEvent>>>(new Map());
  const jobIdsRef = useRef<Map<string, string>>(new Map());
  const { notifyError } = useToast();

  const updateJob = useCallback((scriptId: string, updater: (prev: JobState) => JobState) => {
    setJobs((prev) => ({
      ...prev,
      [scriptId]: updater(prev[scriptId] ?? emptyJobState()),
    }));
  }, []);

  const run = useCallback(
    async (scriptId: string, values: Record<string, unknown>): Promise<string | null> => {
      updateJob(scriptId, () => ({
        ...emptyJobState(),
        running: true,
      }));

      const channel = new Channel<JobEvent>();
      channelsRef.current.set(scriptId, channel);

      channel.onmessage = (event: JobEvent) => {
        if (event.kind === "lines") {
          updateJob(scriptId, (prev) => {
            const next = [...prev.lines, ...event.batch];
            // Head+tail cap: keep first HEAD_KEEP + last TAIL_KEEP lines (audit M9)
            if (next.length > MAX_LINES) {
              const head = next.slice(0, HEAD_KEEP);
              const tail = next.slice(next.length - TAIL_KEEP);
              const banner: LogLine = {
                stream: "stderr",
                text: `… ${next.length - MAX_LINES} lines dropped (showing head+tail) …`,
                ts: Date.now(),
              };
              return { ...prev, lines: [...head, banner, ...tail] };
            }
            return { ...prev, lines: next };
          });
        } else if (event.kind === "structured") {
          const ev = event.event as Record<string, unknown>;
          const type = ev.type as string | undefined;
          if (type === "progress") {
            updateJob(scriptId, (prev) => ({
              ...prev,
              structured: {
                ...prev.structured,
                progress: { pct: ev.pct as number, message: (ev.message as string) ?? "" },
              },
            }));
          } else if (type === "table") {
            updateJob(scriptId, (prev) => ({
              ...prev,
              structured: {
                ...prev.structured,
                table: {
                  columns: (ev.columns as string[]) ?? [],
                  rows: (ev.rows as unknown[][]) ?? [],
                },
              },
            }));
          } else if (type === "status") {
            updateJob(scriptId, (prev) => ({
              ...prev,
              structured: {
                ...prev.structured,
                status: ev.message as string,
              },
            }));
          } else if (type === "markdown") {
            updateJob(scriptId, (prev) => ({
              ...prev,
              structured: {
                ...prev.structured,
                markdown: (ev.content as string) ?? "",
              },
            }));
          } else if (type === "chart") {
            updateJob(scriptId, (prev) => ({
              ...prev,
              structured: {
                ...prev.structured,
                chart: {
                  chartType: (ev.chart_type as "line" | "bar") ?? "line",
                  title: (ev.title as string | null) ?? null,
                  labels: (ev.labels as string[]) ?? [],
                  series: (ev.series as ChartSeries[]) ?? [],
                },
              },
            }));
          } else if (type === "log_file") {
            updateJob(scriptId, (prev) => ({
              ...prev,
              logFilePath: (ev.path as string) ?? null,
            }));
          }
        } else if (event.kind === "exit") {
          updateJob(scriptId, (prev) => ({
            ...prev,
            exitInfo: event,
            running: false,
          }));
        }
      };

      try {
        const jobId = await ipc<string>("run_script", {
          scriptId,
          values,
          onEvent: channel,
        });
        jobIdsRef.current.set(scriptId, jobId);
        updateJob(scriptId, (prev) => ({ ...prev, jobId }));
        return jobId;
      } catch (e) {
        updateJob(scriptId, (prev) => ({
          ...prev,
          running: false,
          lines: [
            ...prev.lines,
            {
              stream: "stderr",
              text: `Error: ${String(e)}`,
              ts: Date.now(),
            },
          ],
        }));
        return null;
      }
    },
    [updateJob],
  );

  const cancel = useCallback(async (scriptId: string) => {
    const jobId = jobIdsRef.current.get(scriptId);
    if (jobId) {
      try {
        await ipc("cancel_job", { jobId });
      } catch (e) {
        notifyError(e, "Cancel failed");
      }
    }
  }, [notifyError]);

  const clearJob = useCallback((scriptId: string) => {
    channelsRef.current.delete(scriptId);
    jobIdsRef.current.delete(scriptId);
    setJobs((prev) => {
      const next = { ...prev };
      delete next[scriptId];
      return next;
    });
  }, []);

  const runningScripts = useMemo(
    () => Object.entries(jobs).filter(([, s]) => s.running).map(([id]) => id),
    [jobs],
  );

  return { jobs, run, cancel, clearJob, runningScripts };
}
