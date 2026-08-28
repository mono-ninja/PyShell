use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::manifest::model::JobId;

/// A handle to a running job, used for cancellation.
pub struct JobHandle {
    pub script_id: String,
    pub cancel_tx: tokio::sync::oneshot::Sender<()>,
}

pub struct JobRegistry {
    jobs: Arc<Mutex<HashMap<JobId, JobHandle>>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn jobs_clone(&self) -> Arc<Mutex<HashMap<JobId, JobHandle>>> {
        Arc::clone(&self.jobs)
    }

    /// Atomically check if the script is already running and insert if not.
    /// Returns Err if the script is already running (audit H5: prevents TOCTOU race).
    pub fn try_insert(&self, job_id: JobId, handle: JobHandle) -> Result<(), String> {
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.values().any(|h| h.script_id == handle.script_id) {
            return Err(format!("script '{}' is already running", handle.script_id));
        }
        jobs.insert(job_id, handle);
        Ok(())
    }

    pub fn insert(&self, job_id: JobId, handle: JobHandle) {
        self.jobs.lock().unwrap().insert(job_id, handle);
    }

    /// Check if a job is already running for the given script_id (Plan.md §M1).
    pub fn is_script_running(&self, script_id: &str) -> bool {
        self.jobs
            .lock()
            .unwrap()
            .values()
            .any(|h| h.script_id == script_id)
    }

    /// Cancel all jobs for a given script_id. Returns the number of jobs cancelled.
    pub fn cancel_for_script(&self, script_id: &str) -> usize {
        let to_cancel: Vec<JobId> = {
            let jobs = self.jobs.lock().unwrap();
            jobs.iter()
                .filter(|(_, h)| h.script_id == script_id)
                .map(|(id, _)| id.clone())
                .collect()
        };
        let count = to_cancel.len();
        for id in to_cancel {
            self.cancel(&id);
        }
        count
    }

    pub fn remove(&self, job_id: &JobId) {
        self.jobs.lock().unwrap().remove(job_id);
    }

    pub fn cancel(&self, job_id: &JobId) -> bool {
        if let Some(handle) = self.jobs.lock().unwrap().remove(job_id) {
            let _ = handle.cancel_tx.send(());
            true
        } else {
            false
        }
    }

    /// Cancel all jobs. Fire-and-forget: sends cancel signals but does not wait.
    /// Called on app exit (Plan.md §M1). The OS will clean up any remaining
    /// processes when the app exits.
    pub fn cancel_all(&self) {
        let handles: Vec<JobHandle> = {
            let mut jobs = self.jobs.lock().unwrap();
            jobs.drain().map(|(_, h)| h).collect()
        };

        for handle in handles {
            let _ = handle.cancel_tx.send(());
        }
    }
}
