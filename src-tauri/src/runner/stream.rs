use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;

use crate::manifest::model::{JobEvent, LogLine};
use crate::runner::group::{self, ProcessKiller};

const TAIL_SIZE: usize = 10_000;

/// How long to wait for the output readers to drain after the process exited.
/// A descendant that escaped the process group can hold the pipe write end open
/// forever, and an unbounded wait there would hang the job.
const READER_DRAIN_GRACE: Duration = Duration::from_secs(5);

/// Batching: flush a pending batch after this long, or once it reaches
/// [`BATCH_LINES`], whichever comes first.
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
const BATCH_LINES: usize = 200;

/// Stream stdout and stderr from a child process, batching lines and sending
/// them via a channel. Batching: ~50ms or 200 lines, whichever comes first.
/// Backpressure: hard cap 50 MB / 500k lines per job (shared across streams).
/// When the cap is hit, the middle is dropped (head + tail kept, banner shown).
///
/// `killer` is used on timeout to kill the whole process tree. It is passed in
/// rather than derived from `child` because on Windows it owns the Job Object
/// handle, which is created in `spawn_script`.
pub async fn stream_output(
    mut child: Child,
    event_sender: impl JobEventSender,
    timeout: Option<u64>,
    killer: ProcessKiller,
) -> (Option<i32>, u64, crate::manifest::model::ExitReason) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Shared counters across both streams — per-job, not per-stream (Plan.md §M5)
    let total_lines = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let total_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let max_lines: usize = 500_000;
    let max_bytes: usize = 50 * 1024 * 1024;

    let stdout_task = if let Some(stdout) = stdout {
        let sender = event_sender.clone();
        let tl = Arc::clone(&total_lines);
        let tb = Arc::clone(&total_bytes);
        Some(tokio::spawn(async move {
            stream_reader(stdout, "stdout", sender, max_lines, max_bytes, tl, tb).await
        }))
    } else {
        None
    };

    let stderr_task = if let Some(stderr) = stderr {
        let sender = event_sender.clone();
        let tl = Arc::clone(&total_lines);
        let tb = Arc::clone(&total_bytes);
        Some(tokio::spawn(async move {
            stream_reader(stderr, "stderr", sender, max_lines, max_bytes, tl, tb).await
        }))
    } else {
        None
    };

    // Wait for the process to exit, with optional timeout
    let start = Instant::now();
    let (exit_code, reason) = if let Some(timeout_secs) = timeout {
        let timeout_dur = Duration::from_secs(timeout_secs);
        tokio::select! {
            result = child.wait() => {
                match result {
                    Ok(status) => (status.code(), classify_exit(status.code())),
                    Err(_) => (None, crate::manifest::model::ExitReason::Killed),
                }
            }
            _ = tokio::time::sleep(timeout_dur) => {
                tracing::warn!("Job exceeded its {}s timeout — killing the process group", timeout_secs);

                // Kill the entire tree, not just the direct child, and escalate:
                // a script that ignores SIGTERM must still die, otherwise the
                // `wait()` below — and with it the whole job — hangs forever.
                // `kill_on_drop` is deliberately not set, so nothing else will
                // do this for us.
                killer.terminate();
                if tokio::time::timeout(group::KILL_GRACE, child.wait()).await.is_err() {
                    tracing::warn!("Process ignored SIGTERM after timeout — escalating to SIGKILL");
                }
                // Force-kill the group even when the direct child did exit: it
                // can die on SIGTERM while a grandchild ignores it and keeps the
                // output pipes open.
                killer.kill();
                let _ = child.wait().await;

                (None, crate::manifest::model::ExitReason::Timeout)
            }
        }
    } else {
        match child.wait().await {
            Ok(status) => (status.code(), classify_exit(status.code())),
            Err(_) => (None, crate::manifest::model::ExitReason::Killed),
        }
    };

    // Wait for the streaming tasks to drain, but not forever (see
    // READER_DRAIN_GRACE) — the process has exited, so the job must finalize.
    join_reader(stdout_task, "stdout").await;
    join_reader(stderr_task, "stderr").await;

    let duration_ms = start.elapsed().as_millis() as u64;

    // Send exit event
    event_sender.send(JobEvent::Exit {
        code: exit_code,
        duration_ms,
        reason: reason.clone(),
    });

    (exit_code, duration_ms, reason)
}

/// Await an output reader, giving up after [`READER_DRAIN_GRACE`] so a
/// descendant still holding the pipe open cannot stall the job forever.
async fn join_reader(task: Option<tokio::task::JoinHandle<()>>, name: &str) {
    if let Some(mut task) = task {
        if tokio::time::timeout(READER_DRAIN_GRACE, &mut task).await.is_err() {
            tracing::warn!(
                "{} still open {:?} after the process exited — abandoning it",
                name,
                READER_DRAIN_GRACE
            );
            task.abort();
        }
    }
}

async fn stream_reader<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    stream_name: &str,
    sender: impl JobEventSender,
    max_lines: usize,
    max_bytes: usize,
    total_lines: Arc<std::sync::atomic::AtomicUsize>,
    total_bytes: Arc<std::sync::atomic::AtomicUsize>,
) {
    let mut buf_reader = BufReader::new(reader);
    let mut batch = Vec::new();
    let mut dropped_count: usize = 0;
    // Ring buffer for the tail: once we hit the cap, store lines here
    // and flush them at EOF.
    let mut tail_buffer: VecDeque<LogLine> = VecDeque::with_capacity(TAIL_SIZE);
    let mut truncating = false;
    let stream = stream_name.to_string();

    let mut buf = Vec::with_capacity(8192);
    let mut next_flush = tokio::time::Instant::now();

    loop {
        // A pending batch has to go out on a timer, not only when the next line
        // arrives: a script that prints a few lines and then works quietly for a
        // minute would otherwise show nothing until it produced more output.
        //
        // The timer branch is guarded on a non-empty batch so an idle stream
        // parks on the read instead of waking every interval.
        //
        // `read_until` appends to `buf` and consumes what it appended, so a
        // cancelled read leaves a partial line in `buf` that the next read
        // continues. That is only safe because `buf` is cleared after a
        // *complete* line, never in the timer branch.
        let mut at_eof = false;
        tokio::select! {
            result = buf_reader.read_until(b'\n', &mut buf) => {
                match result {
                    // A partial line can be sitting in `buf` if the timer fired
                    // mid-line; emit it rather than dropping it.
                    Ok(0) if buf.is_empty() => break,
                    Ok(0) => at_eof = true,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            _ = tokio::time::sleep_until(next_flush), if !batch.is_empty() => {
                flush_batch(&mut batch, &sender);
                next_flush = tokio::time::Instant::now() + FLUSH_INTERVAL;
                continue;
            }
        }

        let line_text = String::from_utf8_lossy(&buf);
        let line_text = line_text
            .trim_end_matches('\n')
            .trim_end_matches('\r')
            .to_string();
        // The line is complete and now owned, so the read buffer is free again.
        buf.clear();

        // Try to parse stderr lines as structured JSON events (Plan.md §M5)
        // Only lines with "pyshell": true are treated as structured (audit M1)
        if stream_name == "stderr" {
            if let Some(event) = crate::runner::protocol::try_parse_structured(&line_text) {
                // Structured events still count toward the output cap
                // (Plan.md §3.4: previously skipped, allowing unbounded growth).
                let line_bytes = line_text.len() + 1;
                let prev_lines = total_lines.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let prev_bytes = total_bytes.fetch_add(line_bytes, std::sync::atomic::Ordering::Relaxed);
                if prev_lines >= max_lines || prev_bytes >= max_bytes {
                    if !truncating {
                        truncating = true;
                        tracing::warn!(
                            "Output cap reached on {} — dropping middle, keeping tail",
                            stream
                        );
                    }
                    tail_buffer.push_back(LogLine {
                        stream: stream.clone(),
                        text: line_text.clone(),
                        ts: now_ms(),
                    });
                    if tail_buffer.len() > TAIL_SIZE {
                        tail_buffer.pop_front();
                    }
                    dropped_count += 1;
                    if at_eof {
                        break;
                    }
                    continue;
                }
                sender.send(crate::runner::protocol::structured_event(event));
                if at_eof {
                    break;
                }
                continue;
            }
        }

        let line = LogLine {
            stream: stream.clone(),
            text: line_text,
            ts: now_ms(),
        };

        let cur_lines = total_lines.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let cur_bytes = total_bytes.fetch_add(line.text.len() + 1, std::sync::atomic::Ordering::Relaxed);

        if cur_lines >= max_lines || cur_bytes >= max_bytes {
            if !truncating {
                truncating = true;
                let banner = LogLine {
                    stream: stream.clone(),
                    text: format!(
                        "… output truncated: reached {} lines / {} MB limit, keeping tail …",
                        max_lines,
                        max_bytes / (1024 * 1024)
                    ),
                    ts: now_ms(),
                };
                batch.push(banner);
                flush_batch(&mut batch, &sender);
            }
            // While truncating: collect into ring buffer instead of emitting
            dropped_count += 1;
            tail_buffer.push_back(line);
            if tail_buffer.len() > TAIL_SIZE {
                tail_buffer.pop_front();
            }
            if at_eof {
                break;
            }
            continue;
        }

        batch.push(line);

        if batch.len() >= BATCH_LINES {
            flush_batch(&mut batch, &sender);
            next_flush = tokio::time::Instant::now() + FLUSH_INTERVAL;
        }

        if at_eof {
            break;
        }
    }

    // If we were truncating, emit the banner with the dropped count and flush the tail
    if truncating {
        let banner = LogLine {
            stream: stream.clone(),
            text: format!("… {} lines dropped, resuming with last {} lines …", dropped_count - tail_buffer.len(), tail_buffer.len()),
            ts: now_ms(),
        };
        batch.push(banner);
        flush_batch(&mut batch, &sender);
        // Flush the tail buffer
        let tail: Vec<LogLine> = tail_buffer.into_iter().collect();
        sender.send(JobEvent::Lines { batch: tail });
    }

    // Final flush
    flush_batch(&mut batch, &sender);
}

fn flush_batch(batch: &mut Vec<LogLine>, sender: &impl JobEventSender) {
    if !batch.is_empty() {
        let batch = std::mem::take(batch);
        sender.send(JobEvent::Lines { batch });
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn classify_exit(code: Option<i32>) -> crate::manifest::model::ExitReason {
    match code {
        Some(0) => crate::manifest::model::ExitReason::Ok,
        Some(_) => crate::manifest::model::ExitReason::Error,
        None => crate::manifest::model::ExitReason::Killed,
    }
}

/// Trait for sending JobEvents — abstracted so we can use Tauri channels.
pub trait JobEventSender: Clone + Send + Sync + 'static {
    fn send(&self, event: JobEvent);
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::manifest::model::ExitReason;
    use crate::runner::group::{spawn_test_group, ProcessKiller};

    /// Collects everything `stream_output` emits so tests can assert on it.
    #[derive(Clone)]
    struct Collector(Arc<std::sync::Mutex<Vec<JobEvent>>>);

    impl Collector {
        fn new() -> Self {
            Self(Arc::new(std::sync::Mutex::new(Vec::new())))
        }

        fn events(&self) -> Vec<JobEvent> {
            self.0.lock().unwrap().clone()
        }

        fn lines(&self) -> Vec<String> {
            self.events()
                .into_iter()
                .filter_map(|e| match e {
                    JobEvent::Lines { batch } => Some(batch),
                    _ => None,
                })
                .flatten()
                .map(|l| l.text)
                .collect()
        }

        fn structured(&self) -> Vec<serde_json::Value> {
            self.events()
                .into_iter()
                .filter_map(|e| match e {
                    JobEvent::Structured { event } => Some(event),
                    _ => None,
                })
                .collect()
        }
    }

    impl JobEventSender for Collector {
        fn send(&self, event: JobEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    /// Run a shell script through the real streaming path.
    /// The outer timeout is a test guard: it only trips if `stream_output`
    /// itself fails to finalize the job.
    async fn run(
        script: &str,
        timeout: Option<u64>,
    ) -> (Option<i32>, ExitReason, Collector) {
        let child = spawn_test_group(script);
        let killer = ProcessKiller::from_child(&child);
        let collector = Collector::new();

        let (code, _duration, reason) = tokio::time::timeout(
            Duration::from_secs(30),
            stream_output(child, collector.clone(), timeout, killer),
        )
        .await
        .expect("stream_output never returned — the job was left hanging");

        (code, reason, collector)
    }

    #[tokio::test]
    async fn timeout_kills_a_script_that_ignores_sigterm() {
        // The misbehaving.py case, reduced to a shell one-liner: SIGTERM is
        // trapped and ignored, so only an escalation to SIGKILL can stop it.
        // Without escalation `stream_output` waits on the child forever and the
        // job never finalizes.
        let (code, reason, collector) =
            run(r#"trap "" TERM; echo started; while :; do sleep 0.1; done"#, Some(1)).await;

        assert!(matches!(reason, ExitReason::Timeout), "reason was {:?}", reason);
        assert_eq!(code, None);
        assert!(
            collector.lines().iter().any(|l| l == "started"),
            "expected the script's output, got {:?}",
            collector.lines()
        );
    }

    #[tokio::test]
    async fn timeout_kills_grandchildren_holding_the_output_pipes() {
        // The direct child exits on SIGTERM but leaves behind a grandchild that
        // ignores it and keeps stdout open. Killing only the direct child leaves
        // the grandchild alive and the output readers waiting on a pipe that
        // never reaches EOF.
        let dir = std::env::temp_dir().join(format!("pyshell-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("grandchild.pid");

        // A separate `sh -c` so `$$` is the grandchild's own pid.
        let script = format!(
            r#"/bin/sh -c 'trap "" TERM; echo $$ > {pid}; while :; do sleep 0.1; done' &
               while :; do sleep 0.1; done"#,
            pid = pidfile.display()
        );

        let (_code, reason, _collector) = run(&script, Some(1)).await;
        assert!(matches!(reason, ExitReason::Timeout), "reason was {:?}", reason);

        let grandchild_pid: i32 = std::fs::read_to_string(&pidfile)
            .expect("grandchild never wrote its pid")
            .trim()
            .parse()
            .expect("bad pid");

        // Reparented to init once its parent died, so it is reaped promptly
        // after the group kill lands and its pid stops resolving.
        let mut gone = false;
        for _ in 0..50 {
            if unsafe { libc::kill(grandchild_pid, 0) } != 0 {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(gone, "grandchild {} survived the timeout kill", grandchild_pid);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_script_that_finishes_in_time_is_not_killed() {
        let (code, reason, collector) = run("echo hello; exit 0", Some(30)).await;

        assert!(matches!(reason, ExitReason::Ok), "reason was {:?}", reason);
        assert_eq!(code, Some(0));
        assert_eq!(collector.lines(), vec!["hello".to_string()]);
    }

    #[tokio::test]
    async fn runs_without_a_timeout() {
        let (code, reason, collector) = run("echo no-timeout", None).await;

        assert!(matches!(reason, ExitReason::Ok), "reason was {:?}", reason);
        assert_eq!(code, Some(0));
        assert_eq!(collector.lines(), vec!["no-timeout".to_string()]);
    }

    #[tokio::test]
    async fn nonzero_exit_is_reported_as_error() {
        let (code, reason, _) = run("exit 3", Some(30)).await;

        assert!(matches!(reason, ExitReason::Error), "reason was {:?}", reason);
        assert_eq!(code, Some(3));
    }

    #[tokio::test]
    async fn death_by_signal_is_reported_as_killed() {
        let (code, reason, _) = run("kill -9 $$", Some(30)).await;

        assert!(matches!(reason, ExitReason::Killed), "reason was {:?}", reason);
        assert_eq!(code, None);
    }

    #[tokio::test]
    async fn an_exit_event_is_always_emitted() {
        let (_, _, collector) = run("echo x", Some(30)).await;

        let exits = collector
            .events()
            .into_iter()
            .filter(|e| matches!(e, JobEvent::Exit { .. }))
            .count();
        assert_eq!(exits, 1, "expected exactly one exit event");
    }

    #[tokio::test]
    async fn only_stderr_json_tagged_pyshell_becomes_a_structured_event() {
        // The other JSON line must stay a normal log line, so scripts that log
        // JSON to stderr don't have their output silently disappear.
        let (_, reason, collector) = run(
            r#"echo '{"pyshell": true, "type": "status", "message": "hi"}' >&2
               echo '{"error": "just a log line"}' >&2
               echo 'plain stderr' >&2"#,
            Some(30),
        )
        .await;
        assert!(matches!(reason, ExitReason::Ok), "reason was {:?}", reason);

        let structured = collector.structured();
        assert_eq!(structured.len(), 1, "got {:?}", structured);
        assert_eq!(structured[0]["type"], "status");
        assert_eq!(structured[0]["message"], "hi");

        let lines = collector.lines();
        assert!(
            lines.iter().any(|l| l.contains("just a log line")),
            "untagged JSON must survive as a log line, got {:?}",
            lines
        );
        assert!(lines.iter().any(|l| l == "plain stderr"), "got {:?}", lines);
    }

    #[tokio::test]
    async fn stdout_and_stderr_are_labelled() {
        let (_, _, collector) = run("echo out; echo err >&2", Some(30)).await;

        let streams: std::collections::HashSet<String> = collector
            .events()
            .into_iter()
            .filter_map(|e| match e {
                JobEvent::Lines { batch } => Some(batch),
                _ => None,
            })
            .flatten()
            .map(|l| l.stream)
            .collect();

        assert!(streams.contains("stdout"), "got {:?}", streams);
        assert!(streams.contains("stderr"), "got {:?}", streams);
    }

    #[tokio::test]
    async fn a_line_is_streamed_before_the_script_finishes() {
        // Prints immediately, then works quietly for 3s. With no flush timer the
        // batch sat in memory until the next line arrived — i.e. until EOF — so
        // "live" output only showed up once the script had already finished.
        let child = spawn_test_group("echo early; sleep 3");
        let killer = ProcessKiller::from_child(&child);
        let collector = Collector::new();

        let job = tokio::spawn(stream_output(child, collector.clone(), None, killer));

        let start = std::time::Instant::now();
        loop {
            if collector.lines().iter().any(|l| l == "early") {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "the line never arrived while the script was still running"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let seen_after = start.elapsed();

        let (_code, _duration, reason) = job.await.expect("stream_output panicked");
        assert!(matches!(reason, ExitReason::Ok), "reason was {:?}", reason);
        assert!(
            seen_after < Duration::from_secs(1),
            "line took {:?} to arrive, so it was not streamed promptly",
            seen_after
        );
    }

    #[tokio::test]
    async fn an_unterminated_final_line_is_still_emitted() {
        // Guards the EOF path: the timer can fire mid-line, leaving a partial
        // line in the read buffer that the final read must still emit.
        let (_code, _reason, collector) = run("printf 'no trailing newline'", Some(30)).await;
        assert!(
            collector.lines().iter().any(|l| l == "no trailing newline"),
            "got {:?}",
            collector.lines()
        );
    }

    #[tokio::test]
    async fn every_line_survives_a_large_burst() {
        // The reader now shares the loop with a timer via select!, so a cancelled
        // read must not lose or duplicate a partially-read line.
        let (_code, _reason, collector) = run(
            "i=0; while [ $i -lt 1000 ]; do echo line$i; i=$((i+1)); done",
            Some(60),
        )
        .await;

        let lines = collector.lines();
        assert_eq!(lines.len(), 1000, "expected 1000 lines, got {}", lines.len());
        assert_eq!(lines[0], "line0");
        assert_eq!(lines[999], "line999");
    }
}
