use sha2::{Digest, Sha256};

/// The env_key is sha256(requirements_lock_content + python_constraint).
/// This automatically triggers a rebuild when dependencies or Python
/// version change — no buttons needed (Plan.md §0).
pub fn compute_env_key(lock_content: &str, python_constraint: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(lock_content.as_bytes());
    hasher.update(b"\x00");
    hasher.update(python_constraint.as_bytes());
    hex::encode(hasher.finalize())
}

/// If no requirements file, use a hash of just the python constraint.
pub fn compute_env_key_no_deps(python_constraint: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"\x00");
    hasher.update(python_constraint.as_bytes());
    hex::encode(hasher.finalize())
}
