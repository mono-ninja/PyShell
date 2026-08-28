//! Killing a script and everything it spawned.
//!
//! On Unix the child is its own process group leader (`setsid()` in `pre_exec`),
//! so `killpg` reaches every descendant. On Windows the child is assigned to a
//! Job Object before it is resumed, so `TerminateJobObject` reaches every
//! descendant.
//!
//! [`ProcessKiller`] is deliberately detached from `tokio::process::Child`: the
//! timeout path lives inside `stream_output` (which owns `child`) and the cancel
//! path lives in `spawn_script` (which does not, because `child` was moved into
//! `stream_output`). Both must be able to kill the same tree.

use std::time::Duration;

/// Grace period between the graceful and the forceful kill phase.
pub const KILL_GRACE: Duration = Duration::from_secs(3);

/// How often to check whether the group died during the grace period.
#[cfg(unix)]
const GRACE_POLL: Duration = Duration::from_millis(50);

#[cfg(unix)]
#[derive(Clone)]
pub struct ProcessKiller {
    /// `None` when the child had already been reaped before we could read its pid.
    pgid: Option<i32>,
}

#[cfg(unix)]
impl ProcessKiller {
    /// Build a killer for a child spawned with `setsid()` in `pre_exec`,
    /// which makes pgid == pid.
    pub fn from_child(child: &tokio::process::Child) -> Self {
        Self {
            pgid: child.id().map(|pid| pid as i32),
        }
    }

    /// SIGTERM to the whole group. Returns false if there is no group to signal.
    pub fn terminate(&self) -> bool {
        match self.pgid {
            Some(pgid) => {
                unsafe { libc::killpg(pgid, libc::SIGTERM) };
                true
            }
            None => false,
        }
    }

    /// SIGKILL to the whole group. Returns false if there is no group to signal.
    pub fn kill(&self) -> bool {
        match self.pgid {
            Some(pgid) => {
                unsafe { libc::killpg(pgid, libc::SIGKILL) };
                true
            }
            None => false,
        }
    }

    /// Whether any process in the group still exists. An unreaped zombie counts
    /// as existing, so this is only meaningful once the direct child is being
    /// reaped by someone (the runner drops it into tokio's orphan queue).
    pub fn group_alive(&self) -> bool {
        match self.pgid {
            Some(pgid) => unsafe { libc::killpg(pgid, 0) == 0 },
            None => false,
        }
    }
}

#[cfg(windows)]
pub struct JobObjectHandle {
    handle: windows::Win32::Foundation::HANDLE,
}

// A Win32 job object handle is process-wide and safe to use from any thread; it
// is only `!Send`/`!Sync` because `HANDLE` wraps a raw pointer. The spawned job
// task holds the killer across await points, so both are required.
#[cfg(windows)]
unsafe impl Send for JobObjectHandle {}
#[cfg(windows)]
unsafe impl Sync for JobObjectHandle {}

#[cfg(windows)]
impl JobObjectHandle {
    pub fn new() -> std::io::Result<Self> {
        use windows::Win32::System::JobObjects::*;

        unsafe {
            let job = CreateJobObjectW(None, None)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

            Ok(Self { handle: job })
        }
    }

    pub fn assign_process(
        &self,
        process_handle: windows::Win32::Foundation::HANDLE,
    ) -> std::io::Result<()> {
        use windows::Win32::System::JobObjects::*;
        unsafe {
            AssignProcessToJobObject(self.handle, process_handle)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        }
    }

    pub fn terminate(&self) -> std::io::Result<()> {
        use windows::Win32::System::JobObjects::*;
        unsafe {
            TerminateJobObject(self.handle, 1)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        }
    }
}

#[cfg(windows)]
impl Drop for JobObjectHandle {
    fn drop(&mut self) {
        use windows::Win32::Foundation::*;
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
#[derive(Clone)]
pub struct ProcessKiller {
    /// `None` when the Job Object could not be created or assigned; we then fall
    /// back to `taskkill /T`, which walks the process tree instead.
    job: Option<std::sync::Arc<JobObjectHandle>>,
    pid: u32,
}

#[cfg(windows)]
impl ProcessKiller {
    pub fn new(job: Option<std::sync::Arc<JobObjectHandle>>, pid: u32) -> Self {
        Self { job, pid }
    }

    /// Windows has no graceful equivalent of SIGTERM for a job tree —
    /// `TerminateJobObject` is immediate — so terminate and kill are the same.
    pub fn terminate(&self) -> bool {
        self.kill()
    }

    pub fn kill(&self) -> bool {
        if let Some(job) = &self.job {
            if job.terminate().is_ok() {
                return true;
            }
        }
        if self.pid == 0 {
            return false;
        }
        std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID"])
            .arg(self.pid.to_string())
            .output()
            .is_ok()
    }
}

impl ProcessKiller {
    /// Graceful then forceful: signal the group, give it `grace` to exit, then
    /// force-kill whatever is left. Used by the cancel path, which cannot
    /// `wait()` on the child (it was moved into `stream_output`).
    ///
    /// On Windows the kill is immediate and `grace` is unused.
    pub async fn terminate_then_kill(&self, grace: Duration) {
        #[cfg(windows)]
        let _ = grace;

        if !self.terminate() {
            return;
        }

        #[cfg(unix)]
        {
            // Poll so a cooperative script isn't held for the full grace period,
            // and so we skip SIGKILL entirely once the group is provably gone.
            let deadline = std::time::Instant::now() + grace;
            while std::time::Instant::now() < deadline {
                tokio::time::sleep(GRACE_POLL).await;
                if !self.group_alive() {
                    return;
                }
            }
            self.kill();
        }
    }
}

/// On Windows: create a Job Object and assign the (suspended) child to it.
///
/// This must happen *before* the process is resumed — otherwise grandchildren
/// spawned in the gap escape the Job Object and survive the kill.
///
/// Resuming is deliberately a separate step ([`resume_process`]) so a failure
/// here cannot leave the process suspended forever.
#[cfg(windows)]
pub fn assign_to_job(child: &tokio::process::Child) -> std::io::Result<JobObjectHandle> {
    use windows::Win32::Foundation::*;

    let process_handle = child
        .raw_handle()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "no raw handle"))?;
    let process_handle = HANDLE(process_handle as *mut _);

    let job = JobObjectHandle::new()?;
    job.assign_process(process_handle)?;
    Ok(job)
}

/// Find the main thread of a process created with `CREATE_SUSPENDED` and resume
/// it. Such a process has exactly one thread.
#[cfg(windows)]
pub fn resume_process(pid: u32) -> std::io::Result<()> {
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Threading::*;

    let tid = find_main_thread(pid)?;

    unsafe {
        let thread_handle = OpenThread(THREAD_SUSPEND_RESUME, false, tid)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let previous = ResumeThread(thread_handle);
        let _ = CloseHandle(thread_handle);

        if previous == u32::MAX {
            return Err(std::io::Error::last_os_error());
        }
    }

    tracing::info!("Resumed process {} (thread {})", pid, tid);
    Ok(())
}

/// Locate the first thread owned by `pid` via a ToolHelp snapshot.
/// The snapshot handle is closed on every path, including the error paths.
#[cfg(windows)]
fn find_main_thread(pid: u32) -> std::io::Result<u32> {
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Diagnostics::ToolHelp::*;

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };

        let mut found = None;
        if Thread32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32OwnerProcessID == pid {
                    found = Some(entry.th32ThreadID);
                    break;
                }
                if Thread32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);

        found.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("no thread found for pid {}", pid),
            )
        })
    }
}

/// Test helper: spawn `sh -c <script>` in its own process group with piped
/// stdio, exactly like the runner spawns a script. Shared with the `stream`
/// tests, which need the same process-group setup.
#[cfg(all(test, unix))]
pub(crate) fn spawn_test_group(script: &str) -> tokio::process::Child {
    use std::process::Stdio;

    let mut cmd = tokio::process::Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().expect("failed to spawn /bin/sh")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    use super::spawn_test_group as spawn_group;

    fn pid_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[tokio::test]
    async fn terminate_then_kill_escalates_when_sigterm_is_ignored() {
        // Traps and ignores SIGTERM — only SIGKILL can stop it.
        let mut child = spawn_group(r#"trap "" TERM; while :; do sleep 0.1; done"#);
        let killer = ProcessKiller::from_child(&child);

        // Give the shell a moment to install the trap.
        tokio::time::sleep(Duration::from_millis(300)).await;

        killer.terminate_then_kill(Duration::from_millis(500)).await;

        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("child was still alive after terminate_then_kill")
            .expect("wait failed");

        // SIGTERM was ignored, so escalating to SIGKILL is what stopped it.
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }

    #[tokio::test]
    async fn terminate_then_kill_lets_a_cooperative_process_exit_on_sigterm() {
        // Default SIGTERM disposition — dies in the graceful phase.
        let mut child = spawn_group("while :; do sleep 0.1; done");
        let killer = ProcessKiller::from_child(&child);
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Reap concurrently, like the runner does: the cancel path drops `child`
        // into tokio's orphan queue, so the pgid stops resolving once it exits.
        let waiter = tokio::spawn(async move { child.wait().await });

        let start = std::time::Instant::now();
        killer.terminate_then_kill(Duration::from_secs(10)).await;
        let elapsed = start.elapsed();

        let status = waiter.await.expect("waiter panicked").expect("wait failed");
        assert_eq!(status.signal(), Some(libc::SIGTERM));

        // Polling must short-circuit the grace period rather than sleeping it out.
        assert!(
            elapsed < Duration::from_secs(5),
            "waited {:?} for a process that died on SIGTERM",
            elapsed
        );
    }

    #[tokio::test]
    async fn kill_reaches_grandchildren_that_ignore_sigterm() {
        let dir = std::env::temp_dir().join(format!("pyshell-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("grandchild.pid");

        // A separate `sh -c` so `$$` is the grandchild's own pid (inside `( )`
        // it would still expand to the outer shell's pid).
        let script = format!(
            r#"/bin/sh -c 'trap "" TERM; echo $$ > {pid}; while :; do sleep 0.1; done' &
               while :; do sleep 0.1; done"#,
            pid = pidfile.display()
        );
        let mut child = spawn_group(&script);
        let killer = ProcessKiller::from_child(&child);

        // Wait for the grandchild to report its pid.
        let mut grandchild_pid = None;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if let Ok(text) = std::fs::read_to_string(&pidfile) {
                if let Ok(pid) = text.trim().parse::<i32>() {
                    grandchild_pid = Some(pid);
                    break;
                }
            }
        }
        let grandchild_pid = grandchild_pid.expect("grandchild never wrote its pid");
        assert!(pid_alive(grandchild_pid), "grandchild should be running");

        killer.terminate_then_kill(Duration::from_millis(500)).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;

        // Once its parent dies the grandchild is reparented and reaped by init,
        // so after the group kill lands its pid stops resolving.
        let mut gone = false;
        for _ in 0..50 {
            if !pid_alive(grandchild_pid) {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(gone, "grandchild {} survived the group kill", grandchild_pid);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn killer_without_a_group_is_a_no_op() {
        let killer = ProcessKiller { pgid: None };
        assert!(!killer.terminate());
        assert!(!killer.kill());
        assert!(!killer.group_alive());

        // Must return promptly rather than sleeping out the grace period.
        let start = std::time::Instant::now();
        killer.terminate_then_kill(Duration::from_secs(30)).await;
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
