//! The Script Store: installable scripts from the community repo.
//!
//! Everything network-facing in PyShell lives here. The catalog is discovered
//! with **one** GitHub Trees API call (`/git/trees/{branch}?recursive=1` —
//! unauthenticated GitHub allows 60 of those per hour, so the result is cached
//! in [`AppState`] for the session and the dialog's Refresh is the only way to
//! spend another). File contents come from `raw.githubusercontent.com`, which
//! is a plain CDN and is not counted against the API limit.
//!
//! The webview points users at the same repo via `SCRIPTS_URL` in
//! `src/lib/links.ts` and `src-tauri/src/menu.rs` — keep all copies in step.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::error::{AppError, Result};
use crate::manifest::model::{AppRelease, RepoScript};

/// The community script collection this module talks to. Split into
/// owner/name because every URL is built from the parts.
const REPO_OWNER: &str = "mono-ninja";
const REPO_NAME: &str = "PyShell-scripts";
const REPO_BRANCH: &str = "main";

/// PyShell's **own** repository — where its releases live. Deliberately a
/// second pair of constants rather than a reuse of the three above: that repo
/// is the script collection, this one is the application, and they move
/// independently.
const APP_REPO_OWNER: &str = "mono-ninja";
const APP_REPO_NAME: &str = "PyShell";

/// Concurrency cap for raw file downloads. Six parallel connections is polite
/// to the CDN and plenty for folders of this size.
const DOWNLOAD_CONCURRENCY: usize = 6;

/// How long a fetched catalog stays usable without re-asking GitHub. The
/// session cache alone made store updates invisible until a manual Refresh
/// (or restart); with a TTL, opening the dialog or launching the app is enough.
/// One refresh costs 2 of the 60 unauthenticated API requests per hour, so
/// five minutes is far below any limit.
const CATALOG_TTL: Duration = Duration::from_secs(5 * 60);

/// How long an update check's answer stays good. Releases appear a few times a
/// year, so re-asking GitHub more often than this only spends the 60
/// unauthenticated requests per hour the Store also draws on. A manual check
/// from the menu ignores it.
const UPDATE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

// Sanity caps for one install. The repo's largest folder is a few dozen small
// files; anything past these numbers means the tree response is not what we
// expected, and writing it to disk is not a good idea.
const MAX_FILES_PER_SCRIPT: usize = 200;
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;

/// Everything a store session needs: the catalog shown in the dialog plus the
/// file tree it was built from, so [`install`] can run without re-asking the
/// API. Cached in `AppState` and rebuilt by an explicit refresh or the TTL.
pub struct Catalog {
    pub entries: Vec<RepoScript>,
    /// Repo-relative path → size in bytes, for every blob under a listed
    /// folder. Install walks this instead of hitting the API again.
    blobs: HashMap<String, u64>,
    /// The commit every URL below was pinned to — see [`raw_url`].
    commit_sha: String,
    /// Wall-clock fetch time, for the TTL. `SystemTime` rather than `Instant`
    /// so tests can backdate it.
    fetched_at: std::time::SystemTime,
}

impl Catalog {
    /// True while the catalog is younger than [`CATALOG_TTL`].
    pub fn is_fresh(&self) -> bool {
        std::time::SystemTime::now()
            .duration_since(self.fetched_at)
            .map(|age| age <= CATALOG_TTL)
            .unwrap_or(false)
    }

    /// Every repo file under `dir` (paths stay repo-relative), sorted, with
    /// sizes. Errors when the dir is not in the catalog — the dialog only
    /// offers listed dirs, so this means the catalog went stale mid-session.
    fn files_under(&self, dir: &str) -> Result<Vec<(String, u64)>> {
        let prefix = format!("{dir}/");
        let mut files: Vec<_> = self
            .blobs
            .iter()
            .filter(|(p, _)| p.starts_with(&prefix))
            .map(|(p, s)| (p.clone(), *s))
            .collect();
        if files.is_empty() {
            return Err(AppError::Other(format!(
                "'{dir}' is not in the store catalog — press Refresh and try again"
            )));
        }
        files.sort();
        Ok(files)
    }
}

/// The answer of one update check, kept in `AppState` so a session does not
/// re-ask GitHub on every render. `release` is `None` when the running build
/// is already current — the *absence of an update* is worth caching too.
pub struct UpdateCheck {
    pub release: Option<AppRelease>,
    checked_at: std::time::SystemTime,
}

impl UpdateCheck {
    pub fn new(release: Option<AppRelease>) -> Self {
        Self { release, checked_at: std::time::SystemTime::now() }
    }

    /// True while the answer is younger than [`UPDATE_TTL`].
    pub fn is_fresh(&self) -> bool {
        std::time::SystemTime::now()
            .duration_since(self.checked_at)
            .map(|age| age <= UPDATE_TTL)
            .unwrap_or(false)
    }
}

/// A shared HTTP client. GitHub rejects requests without a User-Agent, and one
/// client reuses the connection pool across catalog fetches and installs.
fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(format!("PyShell/{}", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client with rustls always builds")
    })
}

fn net(e: reqwest::Error) -> AppError {
    AppError::Network(e.to_string())
}

// --- GitHub API shapes ------------------------------------------------------

/// Response of `/git/ref/heads/main` — just the commit the branch points at.
#[derive(Deserialize)]
struct RefResponse {
    object: RefObject,
}

#[derive(Deserialize)]
struct RefObject {
    sha: String,
}

/// Response of `/git/trees/{sha}?recursive=1`.
#[derive(Deserialize)]
struct TreeResponse {
    tree: Vec<TreeEntry>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Deserialize)]
struct TreeEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    size: Option<u64>,
}

/// The subset of `pyshell.yaml` the store listing needs. A dedicated struct
/// rather than [`crate::manifest::yaml::parse_yaml_manifest`], which needs a
/// file on disk and a full valid schema — here a broken `inputs:` section must
/// not hide a folder from the listing, and parsing text in memory is enough.
///
/// `id` is required: it is what matches an imported `ScriptEntry`, so a
/// manifest without one cannot power the "Installed" badge and is skipped.
#[derive(Deserialize, Clone, Debug)]
struct CatalogMeta {
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    version: Option<String>,
    /// Other store scripts this one needs, by manifest id — powers
    /// [`install_closure`].
    #[serde(default)]
    needs: Vec<String>,
}

// --- Pure catalog construction (unit-tested, no network) --------------------

/// Group tree blobs by the top-level folder they live in, keeping only folders
/// that qualify for the store: a directory (not `_`- or `.`-prefixed — the
/// repo's `_reference` is authoring docs, dotfolders are repo housekeeping)
/// with a `pyshell.yaml` directly inside it.
fn script_folders(tree: &[TreeEntry]) -> HashMap<String, Vec<(String, u64)>> {
    let mut folders: HashMap<String, Vec<(String, u64)>> = HashMap::new();
    for entry in tree {
        if entry.kind != "blob" {
            continue;
        }
        let Some((dir, _)) = entry.path.split_once('/') else {
            continue; // repo-root file (README, LICENSE, …)
        };
        if dir.starts_with('.') || dir.starts_with('_') {
            continue;
        }
        folders
            .entry(dir.to_string())
            .or_default()
            .push((entry.path.clone(), entry.size.unwrap_or(0)));
    }
    folders.retain(|dir, files| files.iter().any(|(p, _)| p == &format!("{dir}/pyshell.yaml")));
    folders
}

/// Assemble the catalog from a tree and the parsed manifests of the folders
/// that had one. Folders whose manifest is absent from `metas` were skipped by
/// the fetcher (with a warning) and stay out of the listing.
///
/// `sha` is the commit the tree and manifests were pinned to; the catalog
/// carries it so installs fetch the exact same snapshot.
fn build_catalog(tree: &[TreeEntry], metas: &HashMap<String, CatalogMeta>, sha: &str) -> Catalog {
    let folders = script_folders(tree);
    let mut entries: Vec<RepoScript> = folders
        .iter()
        .filter_map(|(dir, files)| {
            let meta = metas.get(dir)?;
            Some(RepoScript {
                dir: dir.clone(),
                id: meta.id.clone(),
                name: meta.name.clone(),
                description: meta.description.clone(),
                icon: meta.icon.clone(),
                category: meta.category.clone(),
                version: meta.version.clone(),
                needs: meta.needs.clone(),
                files: files.len() as u64,
                size_bytes: files.iter().map(|(_, s)| s).sum(),
                // Filled in per call by `repo_catalog` — installs during the
                // session change it, so it must not be baked into the cache.
                installed_version: None,
            })
        })
        .collect();
    // Case-insensitive, matching how the sidebar orders scripts, so the store
    // reads as one list with it.
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let blobs = folders.into_values().flatten().collect();
    Catalog {
        entries,
        blobs,
        commit_sha: sha.to_string(),
        fetched_at: std::time::SystemTime::now(),
    }
}

/// The folders to install for one Store install: the requested script plus
/// every script it *transitively* needs that is neither installed nor already
/// in the list — so one click on a pipeline's last stage pulls in the whole
/// chain.
///
/// - Needs are declared as **ids**; they resolve to catalog dirs, so a need
///   that is not a store script (a local-only helper) is skipped with a
///   warning rather than failing the install — it just stays a missing-dependency
///   pill afterwards.
/// - The visited set cuts cycles: `a needs b, b needs a` installs each once.
/// - The chain length is capped: a repo with a pathological graph cannot queue
///   an unbounded download.
///
/// Root-first order, so if a later folder fails the user still has the script
/// they actually clicked on. Pure function over the catalog.
pub fn install_closure(
    root: &str,
    catalog: &Catalog,
    installed: &std::collections::HashSet<String>,
) -> Result<Vec<String>> {
    const MAX_CHAIN: usize = 12;

    let root_entry = catalog
        .entries
        .iter()
        .find(|e| e.dir == root)
        .ok_or_else(|| {
            AppError::Other(format!(
                "'{root}' is not in the store catalog — press Refresh and try again"
            ))
        })?;

    // id → dir, for resolving `needs` to catalog folders.
    let dir_of_id: HashMap<&str, &str> = catalog
        .entries
        .iter()
        .map(|e| (e.id.as_str(), e.dir.as_str()))
        .collect();

    let mut ordered: Vec<String> = Vec::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut queue: Vec<&RepoScript> = vec![root_entry];
    while let Some(entry) = queue.pop() {
        if !visited.insert(entry.dir.clone()) {
            continue; // cycle or diamond — install each folder once
        }
        for need in &entry.needs {
            if installed.contains(need) {
                continue;
            }
            match dir_of_id.get(need.as_str()) {
                Some(dir) => {
                    if let Some(e) = catalog.entries.iter().find(|e| e.dir == *dir) {
                        queue.push(e);
                    }
                }
                None => tracing::warn!(
                    "store: '{need}' is needed by '{}' but is not in the catalog — \
                     it will show as a missing dependency",
                    entry.dir
                ),
            }
        }
        ordered.push(entry.dir.clone());
    }

    if ordered.len() > MAX_CHAIN {
        return Err(AppError::Other(format!(
            "installing '{root}' would pull in {} scripts — more than the {MAX_CHAIN} PyShell \
             installs in one go",
            ordered.len()
        )));
    }
    Ok(ordered)
}

/// A store dir name is a single path component straight from the catalog, but
/// it crosses the IPC boundary, so it is validated again here before it ever
/// reaches a path join.
fn validate_dir(dir: &str) -> Result<()> {
    let bad = dir.is_empty()
        || dir == "."
        || dir == ".."
        || dir.starts_with('.')
        || dir.starts_with('_')
        || dir.contains('/')
        || dir.contains('\\');
    if bad {
        return Err(AppError::Other(format!("'{dir}' is not a valid store folder")));
    }
    Ok(())
}

/// Join `rel` onto `base`, refusing anything that could escape it or that
/// would need URL encoding. The components come from the GitHub tree API;
/// validating them keeps a hostile or corrupted response from writing outside
/// the destination, and the ASCII-only charset means the raw download URL
/// needs no percent-encoding.
fn safe_join(base: &Path, rel: &str) -> Result<PathBuf> {
    let mut out = base.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(AppError::Other(format!("refusing unsafe repo path: '{rel}'")));
        }
        if !part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err(AppError::Other(format!(
                "repo path has unsupported characters: '{rel}'"
            )));
        }
        out.push(part);
    }
    Ok(out)
}

/// Enforce the per-install sanity caps before anything is written.
fn enforce_caps(files: &[(String, u64)]) -> Result<()> {
    if files.len() > MAX_FILES_PER_SCRIPT {
        return Err(AppError::Other(format!(
            "folder has {} files — PyShell installs at most {MAX_FILES_PER_SCRIPT}",
            files.len()
        )));
    }
    if let Some((path, size)) = files.iter().find(|(_, s)| *s > MAX_FILE_BYTES) {
        return Err(AppError::Other(format!(
            "{path} is {} MB — larger than the {} MB per-file limit",
            size / (1024 * 1024),
            MAX_FILE_BYTES / (1024 * 1024)
        )));
    }
    let total: u64 = files.iter().map(|(_, s)| s).sum();
    if total > MAX_TOTAL_BYTES {
        return Err(AppError::Other(format!(
            "folder is {} MB in total — larger than the {} MB limit",
            total / (1024 * 1024),
            MAX_TOTAL_BYTES / (1024 * 1024)
        )));
    }
    Ok(())
}

// --- Network ----------------------------------------------------------------

fn ref_url() -> String {
    format!("https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/git/ref/heads/{REPO_BRANCH}")
}

fn tree_url(sha: &str) -> String {
    format!(
        "https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/git/trees/{sha}?recursive=1"
    )
}

/// Raw content **pinned to a commit sha** — never to the branch.
///
/// `raw.githubusercontent.com/…/main/…` is served by a CDN that caches for
/// five minutes, so right after a push the store would read the *old*
/// manifest and an update would stay invisible; worse, a multi-file install
/// could mix versions as the cache expired per-file. The refs API (always
/// fresh) gives us the commit, and content behind an immutable sha is exactly
/// what a CDN *should* cache — so every manifest read and file download of
/// one catalog fetch is byte-for-byte the same snapshot.
fn raw_url(sha: &str, path: &str) -> String {
    format!("https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/{sha}/{path}")
}

/// Check for GitHub's unauthenticated rate limit, which is how it answers
/// "too many API requests" (60/hour, and a catalog refresh spends two).
fn rate_limit(status: reqwest::StatusCode) -> Option<AppError> {
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Some(AppError::Network(
            "GitHub API rate limit reached (60 requests/hour without a token; a refresh \
             spends 2). Try again in about an hour."
                .into(),
        ));
    }
    None
}

/// The commit `main` currently points at.
async fn fetch_head_commit() -> Result<String> {
    let resp = client().get(ref_url()).send().await.map_err(net)?;
    let status = resp.status();
    if let Some(e) = rate_limit(status) {
        return Err(e);
    }
    if !status.is_success() {
        return Err(AppError::Network(format!(
            "GitHub returned HTTP {status} for the repo ref"
        )));
    }
    let body: RefResponse = resp.json().await.map_err(net)?;
    Ok(body.object.sha)
}

async fn fetch_tree(sha: &str) -> Result<Vec<TreeEntry>> {
    let resp = client().get(tree_url(sha)).send().await.map_err(net)?;
    let status = resp.status();
    if let Some(e) = rate_limit(status) {
        return Err(e);
    }
    if !status.is_success() {
        return Err(AppError::Network(format!(
            "GitHub returned HTTP {status} for the repo tree"
        )));
    }
    let body: TreeResponse = resp.json().await.map_err(net)?;
    if body.truncated {
        tracing::warn!("repo tree was truncated by GitHub — the store listing may be incomplete");
    }
    Ok(body.tree)
}

/// One GET with a generous per-file timeout (a big font or dataset on a slow
/// link can take longer than the client-wide default). Transport failures and
/// HTTP status failures are kept apart so retries can target the transient
/// kind.
async fn get_bytes(url: &str) -> std::result::Result<Vec<u8>, FetchError> {
    let resp = client()
        .get(url)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(FetchError::Transport)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(FetchError::Status(status));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(FetchError::Transport)
}

enum FetchError {
    /// No response arrived at all — connection refused/reset, timeout, TLS.
    /// Transient, worth another attempt.
    Transport(reqwest::Error),
    /// The server answered with a non-success status. Deterministic: a 404
    /// stays a 404, so retrying only burns the rate limit.
    Status(reqwest::StatusCode),
}

/// Fetch with retries: a transport-level failure gets two more attempts with
/// backoff (one dropped connection must not kill a 40-file install), an HTTP
/// status fails fast.
async fn fetch_bytes(url: &str) -> Result<Vec<u8>> {
    const ATTEMPTS: u32 = 3;
    let mut delay = Duration::from_millis(400);
    for attempt in 1..=ATTEMPTS {
        match get_bytes(url).await {
            Ok(bytes) => return Ok(bytes),
            Err(FetchError::Status(s)) => {
                return Err(AppError::Network(format!("HTTP {s} for {url}")));
            }
            Err(FetchError::Transport(e)) if attempt < ATTEMPTS => {
                tracing::warn!(
                    "store download attempt {attempt}/{ATTEMPTS} failed for {url}: {e} — retrying"
                );
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
            Err(FetchError::Transport(e)) => {
                return Err(AppError::Network(e.to_string()));
            }
        }
    }
    unreachable!("every arm of the loop returns")
}

/// Fetch every listed folder's `pyshell.yaml` and parse the listing fields.
///
/// A folder whose manifest fails to download or parse is skipped with a
/// warning — one author's typo should not blank the store. Only when *every*
/// fetch fails (network down mid-session) does this return an error, since an
/// empty catalog would look like an empty repo.
async fn fetch_manifests(dirs: &[String], sha: &str) -> Result<HashMap<String, CatalogMeta>> {
    let sem = Arc::new(tokio::sync::Semaphore::new(DOWNLOAD_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for dir in dirs {
        let (sem, dir) = (sem.clone(), dir.clone());
        let url = raw_url(sha, &format!("{dir}/pyshell.yaml"));
        set.spawn(async move {
            let _permit = sem
                .acquire_owned()
                .await
                .map_err(|e| AppError::Other(e.to_string()))?;
            let bytes = fetch_bytes(&url).await?;
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let meta: CatalogMeta = serde_yaml::from_str(&text)
                .map_err(|e| AppError::Manifest(format!("{dir}/pyshell.yaml: {e}")))?;
            Ok::<_, AppError>((dir, meta))
        });
    }

    let mut metas = HashMap::new();
    let mut last_err = None;
    while let Some(res) = set.join_next().await {
        match res {
            Ok(Ok((dir, meta))) => {
                metas.insert(dir, meta);
            }
            Ok(Err(e)) => {
                tracing::warn!("skipping store entry: {e}");
                last_err = Some(e);
            }
            Err(e) => last_err = Some(AppError::Other(format!("download task failed: {e}"))),
        }
    }
    if metas.is_empty() && !dirs.is_empty() {
        return Err(last_err.unwrap_or_else(|| {
            AppError::Network("no script manifests could be fetched from the repo".into())
        }));
    }
    Ok(metas)
}

/// Fetch the repo tree and every folder manifest, and assemble the catalog —
/// all pinned to one commit (see [`raw_url`]). Called by the IPC commands;
/// they own the session cache and its TTL.
pub async fn fetch_catalog() -> Result<Catalog> {
    let sha = fetch_head_commit().await?;
    let tree = fetch_tree(&sha).await?;
    let folders = script_folders(&tree);
    let mut dirs: Vec<String> = folders.keys().cloned().collect();
    dirs.sort();
    let metas = fetch_manifests(&dirs, &sha).await?;
    Ok(build_catalog(&tree, &metas, &sha))
}

// --- Install ----------------------------------------------------------------

/// Payload of the `repo:install-progress` event. Low-frequency by
/// construction — one event per completed file of a single-folder install.
#[derive(Serialize, Clone)]
struct InstallProgress<'a> {
    dir: &'a str,
    done: u64,
    total: u64,
}

/// Validate `dir`, enforce the caps, and download every file of the folder
/// into a fresh dot-prefixed staging directory inside `parent` — the parent of
/// where the final folder will live, so the finishing rename never crosses a
/// volume. A failed download removes the staging directory and errors, so
/// nothing partial ever reaches disk under the real name.
///
/// Returns the staging path; the caller decides what happens with it (fresh
/// install or update swap).
async fn stage_folder(
    dir: &str,
    parent: &Path,
    catalog: &Catalog,
    app: Option<&tauri::AppHandle>,
) -> Result<(PathBuf, usize)> {
    validate_dir(dir)?;
    let files = catalog.files_under(dir)?;
    enforce_caps(&files)?;

    if !parent.is_dir() {
        return Err(AppError::Other(format!(
            "folder does not exist: {}",
            parent.display()
        )));
    }
    let staging = parent.join(format!(
        ".{}.tmp-{}",
        dir,
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::create_dir_all(&staging)?;

    if let Err(e) = download_files(&files, dir, &catalog.commit_sha, &staging, app.cloned()).await {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok((staging, files.len()))
}

/// Download one script folder from the repo into `destination/{dir}`.
///
/// The staging dir is renamed into place only after every file arrived (same
/// volume, so the rename is atomic). If the target folder already exists the
/// install refuses — the explicit path for an existing install is
/// [`update_in_place`].
///
/// `app` is where progress events go; `None` means silent (tests).
///
/// Returns the imported folder's path; the command layer then runs it through
/// `import_script`, so schema resolution, bookmarks, the watcher and favorites
/// behave exactly like a local "+ Folder" import.
pub async fn install(
    dir: &str,
    destination: &Path,
    catalog: &Catalog,
    app: Option<&tauri::AppHandle>,
) -> Result<PathBuf> {
    let target = destination.join(dir);
    if target.exists() {
        return Err(AppError::Other(format!(
            "{} already exists — choose another destination, or remove the folder to install again",
            target.display()
        )));
    }

    let (staging, n_files) = stage_folder(dir, destination, catalog, app).await?;
    tracing::info!("store install: {dir} → {} ({n_files} files)", target.display());
    if let Err(e) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(AppError::Io(e));
    }
    tracing::info!("store install complete: {dir}");
    Ok(target)
}

/// Replace an installed script's folder (`target`) with the repo's current
/// `dir`, keeping the old folder as `<name>.backup-<timestamp>` beside it.
///
/// Semantics, deliberately:
///
/// - **Nothing is lost.** The old folder is renamed, not deleted, so local
///   edits and files the user added survive in the backup. The fresh folder is
///   exactly the repo's contents.
/// - **PyShell state is untouched by the swap.** Presets, history and secrets
///   are keyed by script id and live in Application Support / the keychain;
///   re-importing the same id (which the command layer does next) replaces the
///   entry but keeps them. The venv flips to Stale if the requirements or
///   Python constraint changed, and is rebuilt on the next Prepare Env.
/// - **The swap is two renames.** If the second one fails, the first is rolled
///   back so the old folder is back in place.
///
/// The folder's own name is preserved — an update works even if the user
/// renamed the folder or imported the script from somewhere else entirely; only
/// its *contents* are replaced with the repo's layout.
pub async fn update_in_place(
    dir: &str,
    target: &Path,
    catalog: &Catalog,
    app: Option<&tauri::AppHandle>,
) -> Result<(PathBuf, PathBuf)> {
    if !target.is_dir() {
        return Err(AppError::Other(format!(
            "the script's folder is missing: {} — relink it first, or remove and install again",
            target.display()
        )));
    }
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Other(format!("{} has no parent folder", target.display())))?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Other(format!("{} has no folder name", target.display())))?;

    let (staging, n_files) = stage_folder(dir, parent, catalog, app).await?;
    tracing::info!("store update: {dir} → {} ({n_files} files)", target.display());

    let backup = match swap_folders(&staging, target) {
        Ok(b) => b,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    // Keep exactly the backup this update just made; drop older ones so the
    // destination does not accumulate a folder per update forever.
    let pruned = prune_backups(parent, &name, 1);
    if pruned > 0 {
        tracing::info!("store: pruned {pruned} older backup(s) of '{name}'");
    }
    tracing::info!("store update complete: {dir} (old folder kept as {})", backup.display());
    Ok((target.to_path_buf(), backup))
}

/// Is this a backup made by [`swap_folders`]? The name after the script's must
/// start with the fixed-width `YYYYMMDD-HHMMSS` stamp. Being strict keeps a
/// user-made `curl.backup-short` from matching: lexicographically it would
/// sort above every real backup and become the survivor while the genuinely
/// newest one got pruned.
fn is_backup_name(name: &str, script: &str) -> bool {
    let Some(rest) = name.strip_prefix(&format!("{script}.backup-")) else {
        return false;
    };
    let b = rest.as_bytes();
    b.len() >= 15
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'-'
        && b[9..15].iter().all(u8::is_ascii_digit)
}

/// Delete older `{name}.backup-*` siblings of a script folder, keeping the
/// newest `keep`. Called after a successful update swap, so the backup the
/// update just made is always the survivor — the user can always roll back
/// one version, but a script updated weekly does not litter its destination
/// with a backup per update forever.
///
/// Only directories matching the exact backup format are candidates:
/// `xcurl.backup-…`, the `curl` folder itself and anything else in the
/// directory are not touched. Returns how many were removed (for the log and
/// the tests).
fn prune_backups(parent: &Path, name: &str, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return 0;
    };
    // Backup names sort lexicographically by timestamp (fixed-width
    // YYYYMMDD-HHMMSS), so a descending name sort is newest-first.
    let mut backups: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .map(|n| is_backup_name(&n.to_string_lossy(), name))
                    .unwrap_or(false)
        })
        .collect();
    backups.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

    let mut removed = 0;
    for old in backups.into_iter().skip(keep) {
        match std::fs::remove_dir_all(&old) {
            Ok(()) => removed += 1,
            Err(e) => tracing::warn!("could not remove old backup {}: {e}", old.display()),
        }
    }
    removed
}

/// Two renames: the old folder becomes a `.backup-<timestamp>-<uuid>` sibling,
/// the staging dir takes its place. If the second rename fails, the first is
/// rolled back so the script is never left without a folder. The short uuid
/// keeps two updates inside the same second from colliding.
///
/// Pure filesystem — unit-tested without network.
fn swap_folders(staging: &Path, target: &Path) -> Result<PathBuf> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Other(format!("{} has no parent folder", target.display())))?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Other(format!("{} has no folder name", target.display())))?;

    let backup = parent.join(format!(
        "{}.backup-{}-{}",
        name,
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        &uuid::Uuid::new_v4().simple().to_string()[..4]
    ));
    std::fs::rename(target, &backup)?;
    if let Err(e) = std::fs::rename(staging, target) {
        // Roll the old folder back before surfacing the error, or the script
        // is left with no folder at all.
        let _ = std::fs::rename(&backup, target);
        return Err(AppError::Io(e));
    }
    Ok(backup)
}

/// Download every file of the folder into `staging`, in parallel, emitting a
/// progress event per completed file. All URLs are pinned to the catalog's
/// `sha`, so every file of an install is the same snapshot — the branch-based
/// CDN cache could otherwise serve a mix of versions as it expires per-file.
/// All paths are validated before the first request so an unsafe tree entry
/// aborts with nothing written.
async fn download_files(
    files: &[(String, u64)],
    dir: &str,
    sha: &str,
    staging: &Path,
    app: Option<tauri::AppHandle>,
) -> Result<()> {
    let prefix = format!("{dir}/");
    let mut targets = Vec::with_capacity(files.len());
    for (path, _) in files {
        // Every catalog path under `dir` starts with the prefix by
        // construction; fall back to the full path rather than panic if that
        // invariant is ever broken.
        let rel = path.strip_prefix(&prefix).unwrap_or(path.as_str());
        let dest = safe_join(staging, rel)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        targets.push((path.clone(), dest));
    }

    let sem = Arc::new(tokio::sync::Semaphore::new(DOWNLOAD_CONCURRENCY));
    let done = Arc::new(AtomicU64::new(0));
    let total = targets.len() as u64;
    let mut set = tokio::task::JoinSet::new();
    let sha = sha.to_string();
    for (path, dest) in targets {
        let (sem, done, dir) = (sem.clone(), done.clone(), dir.to_string());
        let (app, sha) = (app.clone(), sha.clone());
        set.spawn(async move {
            let _permit = sem
                .acquire_owned()
                .await
                .map_err(|e| AppError::Other(e.to_string()))?;
            let bytes = fetch_bytes(&raw_url(&sha, &path)).await?;
            tokio::fs::write(&dest, &bytes).await?;
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some(app) = &app {
                let _ = app.emit(
                    "repo:install-progress",
                    InstallProgress {
                        dir: dir.as_str(),
                        done: n,
                        total,
                    },
                );
            }
            Ok::<(), AppError>(())
        });
    }
    // First failure aborts the loop; dropping `set` cancels the tasks still
    // in flight, and the caller removes the staging directory.
    while let Some(res) = set.join_next().await {
        res.map_err(|e| AppError::Other(format!("download task failed: {e}")))??;
    }
    Ok(())
}

// --- The app's own updates --------------------------------------------------
//
// Not the Script Store: this checks whether a newer *PyShell* has been
// published, and it stops at telling the user. There is no auto-update — the
// Tauri updater needs a signing key and a `latest.json` the release pipeline
// does not produce — so the whole feature is one API call plus a link to the
// release page.

fn latest_release_url() -> String {
    format!("https://api.github.com/repos/{APP_REPO_OWNER}/{APP_REPO_NAME}/releases/latest")
}

/// Response of `/releases/latest` — only the two fields the notice needs.
#[derive(Deserialize)]
struct ReleaseResponse {
    tag_name: String,
    html_url: String,
}

/// The newest **published** release of PyShell, or `None` when there is none.
///
/// `/releases/latest` ignores drafts and pre-releases by design, and answers
/// **404** when every release is still a draft. That is the normal state of a
/// repo whose maintainer reviews builds before publishing them, not a failure
/// worth a toast, so it maps to `None` rather than an error.
pub async fn latest_release() -> Result<Option<AppRelease>> {
    let resp = client().get(latest_release_url()).send().await.map_err(net)?;
    let status = resp.status();
    if status.as_u16() == 404 {
        tracing::info!(
            "{APP_REPO_OWNER}/{APP_REPO_NAME} has no published release (drafts are invisible \
             to the API)"
        );
        return Ok(None);
    }
    if let Some(e) = rate_limit(status) {
        return Err(e);
    }
    if !status.is_success() {
        return Err(AppError::Network(format!(
            "GitHub returned HTTP {status} for the latest release"
        )));
    }
    let body: ReleaseResponse = resp.json().await.map_err(net)?;
    Ok(Some(AppRelease {
        version: normalize_version(&body.tag_name),
        url: body.html_url,
    }))
}

/// The release to offer as an update: the latest one, but only if it is newer
/// than `current`. `None` means "nothing to offer" — up to date, no published
/// release, or a tag that could not be read as a version.
///
/// The running version is passed in rather than read from
/// `env!("CARGO_PKG_VERSION")` on purpose. Tauri takes the app's version from
/// `tauri.conf.json` when that field is set and only falls back to
/// `Cargo.toml`, so the two can drift — and the compiled-in constant would
/// then disagree with the version Settings shows and the bundle carries,
/// offering an update to a version already installed. The caller hands over
/// `package_info().version`, which is the same value on every side.
pub async fn app_update(current: &str) -> Result<Option<AppRelease>> {
    Ok(latest_release()
        .await?
        .filter(|r| is_newer(current, &r.version)))
}

/// Tag → version: `v0.4.0` and `0.4.0` are the same release.
fn normalize_version(tag: &str) -> String {
    tag.trim().trim_start_matches('v').to_string()
}

/// Split a version into its numeric components, or `None` if it is not one.
///
/// Deliberately not a semver dependency: the tags this compares are
/// `vMAJOR.MINOR.PATCH`, and any suffix (`-beta`, `+build`) is cut before
/// parsing because `/releases/latest` never returns a pre-release anyway.
fn version_parts(v: &str) -> Option<Vec<u64>> {
    let core = normalize_version(v);
    let core = core.split(['-', '+']).next()?;
    let parts: Option<Vec<u64>> = core.split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty())
}

/// True when `latest` is strictly newer than `current`.
///
/// Missing components count as zero, so `0.4` is newer than `0.3.9` and equal
/// to `0.4.0`. Anything unparseable on either side compares as *not* newer: a
/// malformed tag must not nag at every launch.
fn is_newer(current: &str, latest: &str) -> bool {
    let (Some(cur), Some(new)) = (version_parts(current), version_parts(latest)) else {
        return false;
    };
    for i in 0..cur.len().max(new.len()) {
        let a = cur.get(i).copied().unwrap_or(0);
        let b = new.get(i).copied().unwrap_or(0);
        if a != b {
            return b > a;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(path: &str, size: u64) -> TreeEntry {
        TreeEntry { kind: "blob".into(), path: path.into(), size: Some(size) }
    }

    fn tree_dir(path: &str) -> TreeEntry {
        TreeEntry { kind: "tree".into(), path: path.into(), size: None }
    }

    fn meta(dir: &str, name: &str) -> (String, CatalogMeta) {
        meta_needing(dir, name, Vec::new())
    }

    fn meta_needing(dir: &str, name: &str, needs: Vec<&str>) -> (String, CatalogMeta) {
        (
            dir.into(),
            CatalogMeta {
                id: format!("com.pyshell.{dir}"),
                name: name.into(),
                description: Some("d".into()),
                icon: None,
                category: Some("SEO".into()),
                version: Some("1".into()),
                needs: needs.into_iter().map(String::from).collect(),
            },
        )
    }

    /// A catalog where `top` needs `mid`, `mid` needs `base`, and `solo` is
    /// independent. Ids follow the `com.pyshell.<dir>` convention of
    /// [`meta_needing`], which is what `install_closure` joins on.
    fn chain_catalog() -> Catalog {
        let entries = vec![
            blob("top/pyshell.yaml", 1),
            blob("top/main.py", 2),
            blob("mid/pyshell.yaml", 1),
            blob("mid/main.py", 2),
            blob("base/pyshell.yaml", 1),
            blob("base/main.py", 2),
            blob("solo/pyshell.yaml", 1),
        ];
        let metas: HashMap<_, _> = [
            meta_needing("top", "Top", vec!["com.pyshell.mid"]),
            meta_needing("mid", "Mid", vec!["com.pyshell.base", "com.pyshell.localonly"]),
            meta("base", "Base"),
            meta("solo", "Solo"),
        ]
        .into_iter()
        .collect();
        build_catalog(&entries, &metas, "sha")
    }

    #[test]
    fn tree_json_parses_the_github_shape() {
        let json = r#"{
            "sha": "x", "url": "u",
            "tree": [
                {"path": "README.md", "mode": "100644", "type": "blob", "size": 10, "sha": "a", "url": "u"},
                {"path": "bot-hunter", "mode": "040000", "type": "tree", "sha": "b", "url": "u"}
            ],
            "truncated": false
        }"#;
        let parsed: TreeResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.tree.len(), 2);
        assert_eq!(parsed.tree[0].kind, "blob");
        assert_eq!(parsed.tree[0].size, Some(10));
        assert!(matches!(parsed.tree[1].kind.as_str(), "tree"));
        assert!(!parsed.truncated);
    }

    #[test]
    fn ref_json_parses_the_head_commit() {
        let json = r#"{
            "ref": "refs/heads/main",
            "node_id": "R",
            "object": {"sha": "206c9a50bcfa75e84430607070119000aee54b56", "type": "commit", "url": "u"}
        }"#;
        let parsed: RefResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.object.sha, "206c9a50bcfa75e84430607070119000aee54b56");
    }

    /// The whole point of pinning: a raw URL built from a sha never mentions
    /// the branch, so the CDN's branch cache cannot serve stale bytes.
    #[test]
    fn raw_urls_are_pinned_to_a_commit_not_the_branch() {
        assert_eq!(
            raw_url("206c9a5", "curl/pyshell.yaml"),
            "https://raw.githubusercontent.com/mono-ninja/PyShell-scripts/206c9a5/curl/pyshell.yaml"
        );
        assert!(!raw_url("206c9a5", "x.py").contains("/main/"));
    }

    #[test]
    fn a_catalog_expires_after_the_ttl() {
        let entries = vec![blob("a/pyshell.yaml", 1), blob("a/main.py", 2)];
        let metas: HashMap<_, _> = [meta("a", "A")].into_iter().collect();
        let mut fresh = build_catalog(&entries, &metas, "sha");
        assert!(fresh.is_fresh(), "just built must be fresh");

        // Backdate past the TTL — SystemTime, unlike Instant, allows it.
        fresh.fetched_at = std::time::SystemTime::UNIX_EPOCH;
        assert!(!fresh.is_fresh(), "a 1970 catalog is stale");
    }

    // --- Dependency closure ---------------------------------------------------

    #[test]
    fn closure_pulls_the_whole_chain_but_not_installed_or_foreign_needs() {
        let catalog = chain_catalog();
        let installed: std::collections::HashSet<String> = ["com.pyshell.base".to_string()]
            .into_iter()
            .collect();

        let dirs = install_closure("top", &catalog, &installed).unwrap();
        // Root first, then its missing dependency; `base` is already installed
        // and `com.pyshell.localonly` is not a store script at all.
        assert_eq!(dirs, vec!["top".to_string(), "mid".to_string()]);
    }

    #[test]
    fn closure_cuts_cycles_and_diamonds() {
        let entries = vec![
            blob("a/pyshell.yaml", 1),
            blob("b/pyshell.yaml", 1),
            blob("c/pyshell.yaml", 1),
        ];
        let metas: HashMap<_, _> = [
            // a ↔ b cycle, plus a diamond: a → c, b → c.
            meta_needing("a", "A", vec!["com.pyshell.b", "com.pyshell.c"]),
            meta_needing("b", "B", vec!["com.pyshell.a", "com.pyshell.c"]),
            meta("c", "C"),
        ]
        .into_iter()
        .collect();
        let catalog = build_catalog(&entries, &metas, "sha");

        let dirs = install_closure("a", &catalog, &std::collections::HashSet::new()).unwrap();
        let mut sorted = dirs.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
        assert_eq!(dirs.len(), dirs.iter().collect::<std::collections::HashSet<_>>().len());
    }

    #[test]
    fn closure_rejects_an_unknown_root_and_an_overlong_chain() {
        let catalog = chain_catalog();
        assert!(install_closure("nope", &catalog, &std::collections::HashSet::new()).is_err());

        // A 13-deep chain exceeds the cap.
        let mut entries = Vec::new();
        let mut metas = Vec::new();
        for i in 0..13 {
            entries.push(blob(&format!("s{i}/pyshell.yaml"), 1));
            let needs = if i == 12 { Vec::new() } else { vec![format!("com.pyshell.s{}", i + 1)] };
            let (d, m) = (
                format!("s{i}"),
                CatalogMeta {
                    id: format!("com.pyshell.s{i}"),
                    name: format!("S{i}"),
                    description: None,
                    icon: None,
                    category: None,
                    version: None,
                    needs,
                },
            );
            metas.push((d, m));
        }
        let deep = build_catalog(&entries, &metas.into_iter().collect(), "sha");
        let err = install_closure("s0", &deep, &std::collections::HashSet::new())
            .unwrap_err()
            .to_string();
        assert!(err.contains("more than"), "{}", err);
    }

    #[test]
    fn manifest_subset_parses_needs() {
        let m: CatalogMeta = serde_yaml::from_str(
            "id: x\nname: X\nneeds:\n  - com.pyshell.sitecrawler\n  - local.abc\n",
        )
        .unwrap();
        assert_eq!(m.needs, vec!["com.pyshell.sitecrawler", "local.abc"]);
    }

    #[test]
    fn only_top_level_folders_with_a_manifest_are_listed() {
        let entries = vec![
            blob("README.md", 100),                 // repo root — not a folder
            blob("LICENSE", 10),
            blob("_reference/authoring-guide.md", 1000), // no pyshell.yaml
            blob(".github/workflows/ci.yml", 500),  // dotfolder
            blob("bot-hunter/main.py", 100),
            blob("bot-hunter/pyshell.yaml", 100),
            blob("bot-hunter/src/lib.py", 50),
            tree_dir("bot-hunter/src"),             // trees are ignored
        ];
        let folders = script_folders(&entries);
        assert_eq!(folders.keys().collect::<Vec<_>>(), vec!["bot-hunter"]);
        assert_eq!(folders["bot-hunter"].len(), 3); // manifest counts as a file
    }

    #[test]
    fn catalog_counts_and_sizes_come_from_the_tree() {
        let entries = vec![
            blob("a-tool/pyshell.yaml", 100),
            blob("a-tool/main.py", 900),
            blob("a-tool/docs/page.md", 50),
            blob("other-tool/pyshell.yaml", 10),
            blob("other-tool/main.py", 10),
        ];
        let metas: HashMap<_, _> = [meta("a-tool", "A Tool"), meta("other-tool", "B Tool")]
            .into_iter()
            .collect();
        let catalog = build_catalog(&entries, &metas, "deadbeef");

        assert_eq!(catalog.entries.len(), 2);
        let a = catalog.entries.iter().find(|e| e.dir == "a-tool").unwrap();
        assert_eq!(a.files, 3);
        assert_eq!(a.size_bytes, 1050);
        assert_eq!(a.id, "com.pyshell.a-tool");
        // Sorted by display name, not folder name.
        assert_eq!(
            catalog.entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
            vec!["A Tool", "B Tool"]
        );
        // Every listed folder's blobs are kept for install.
        assert_eq!(catalog.blobs.len(), 5);
    }

    #[test]
    fn a_folder_without_a_parsed_manifest_is_left_out() {
        let entries = vec![blob("broken/pyshell.yaml", 10), blob("broken/main.py", 10)];
        let catalog = build_catalog(&entries, &HashMap::new(), "deadbeef");
        assert!(catalog.entries.is_empty());
    }

    #[test]
    fn manifest_subset_accepts_plain_scalar_version() {
        // Every manifest in the repo writes `version: 1`, not `version: "1"`.
        let m: CatalogMeta = serde_yaml::from_str(
            "id: x\nname: X\nversion: 1\ndescription: d\nicon: lucide:bot\ncategory: SEO\n",
        )
        .unwrap();
        assert_eq!(m.version.as_deref(), Some("1"));
        assert_eq!(m.icon.as_deref(), Some("lucide:bot"));
    }

    #[test]
    fn files_under_lists_only_that_folder_and_errors_on_unknown() {
        let entries = vec![
            blob("a/pyshell.yaml", 1),
            blob("a/main.py", 2),
            blob("b/pyshell.yaml", 3),
            blob("b/main.py", 4),
        ];
        let metas: HashMap<_, _> = [meta("a", "A"), meta("b", "B")].into_iter().collect();
        let catalog = build_catalog(&entries, &metas, "deadbeef");

        let files = catalog.files_under("b").unwrap();
        assert_eq!(files, vec![("b/main.py".to_string(), 4), ("b/pyshell.yaml".to_string(), 3)]);
        assert!(catalog.files_under("nope").is_err());
    }

    #[test]
    fn validate_dir_rejects_unsafe_names() {
        for bad in ["", ".", "..", ".git", "_ref", "a/b", "a\\b"] {
            assert!(validate_dir(bad).is_err(), "{bad:?} should be rejected");
        }
        assert!(validate_dir("bot-hunter").is_ok());
        assert!(validate_dir("svg_sprite").is_ok());
    }

    #[test]
    fn safe_join_refuses_traversal_and_unusual_characters() {
        let base = Path::new("/tmp/x");
        for bad in ["..", "a/../b", "/abs", "a b.txt", "café.md"] {
            assert!(safe_join(base, bad).is_err(), "{bad:?} should be refused");
        }
        assert_eq!(safe_join(base, "src/lib.py").unwrap(), Path::new("/tmp/x/src/lib.py"));
        assert_eq!(safe_join(base, ".hidden").unwrap(), Path::new("/tmp/x/.hidden"));
    }

    #[test]
    fn caps_reject_oversized_folders() {
        let mb = 1024 * 1024;
        let many: Vec<_> = (0..=MAX_FILES_PER_SCRIPT)
            .map(|i| (format!("f{i}.py"), 10))
            .collect();
        assert!(enforce_caps(&many).is_err());

        let big_file = vec![("font.ttf".to_string(), 11 * mb)];
        assert!(enforce_caps(&big_file).is_err());

        let big_total: Vec<_> = (0..20).map(|i| (format!("f{i}.bin"), 6 * mb)).collect();
        assert!(enforce_caps(&big_total).is_err());

        let fine = vec![("main.py".to_string(), 1000), ("pyshell.yaml".to_string(), 200)];
        assert!(enforce_caps(&fine).is_ok());
    }

    #[test]
    fn swap_replaces_the_folder_and_keeps_the_old_one_as_backup() {
        let parent = std::env::temp_dir().join(format!("pyshell-swap-{}", uuid::Uuid::new_v4()));
        let target = parent.join("bot-hunter");
        let staging = parent.join(".bot-hunter.tmp-x");
        std::fs::create_dir_all(target.join("src")).unwrap();
        std::fs::create_dir_all(staging.join("docs")).unwrap();
        // "Local edit" in the old folder and a repo-shaped new folder.
        std::fs::write(target.join("src/old.py"), b"old").unwrap();
        std::fs::write(target.join("my-notes.txt"), b"notes").unwrap();
        std::fs::write(staging.join("main.py"), b"new").unwrap();
        std::fs::write(staging.join("docs/page.md"), b"page").unwrap();

        let backup = swap_folders(&staging, &target).unwrap();

        // The target is now the staged (repo) content…
        assert!(target.join("main.py").is_file());
        assert!(target.join("docs/page.md").is_file());
        assert!(!target.join("src/old.py").exists(), "repo layout replaces the old one");
        // …and everything from before — including user-added files — survives
        // in the backup.
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("bot-hunter.backup-"));
        assert!(backup.join("src/old.py").is_file());
        assert!(backup.join("my-notes.txt").is_file());
        // No staging leftovers.
        assert!(!staging.exists());

        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn prune_keeps_the_newest_backup_and_never_touches_neighbours() {
        let parent = std::env::temp_dir().join(format!("pyshell-prune-{}", uuid::Uuid::new_v4()));
        for d in [
            "curl",                                // the script folder itself
            "curl.backup-20260101-000000-aaaa",    // oldest
            "curl.backup-20260202-000000-bbbb",    // middle
            "curl.backup-20260303-000000-cccc",    // newest — must survive
            "curl.backup-short",                   // hand-made, not our format — must survive
            "xcurl.backup-20260404-000000-dddd",   // different script — must survive
            "unrelated",
        ] {
            std::fs::create_dir_all(parent.join(d)).unwrap();
        }
        // A *file* with a backup-looking name is not a backup directory.
        std::fs::write(parent.join("curl.backup-20260505-000000-eeee"), b"x").unwrap();

        let removed = prune_backups(&parent, "curl", 1);

        // The two older real backups are gone; the newest, the hand-made
        // `short` one (wrong format — never a candidate), the neighbour
        // script's backup, the folder itself and the file all survive.
        assert_eq!(removed, 2);
        assert!(parent.join("curl.backup-20260303-000000-cccc").is_dir());
        assert!(!parent.join("curl.backup-20260101-000000-aaaa").exists());
        assert!(!parent.join("curl.backup-20260202-000000-bbbb").exists());
        assert!(parent.join("curl.backup-short").is_dir());
        assert!(parent.join("curl").is_dir());
        assert!(parent.join("xcurl.backup-20260404-000000-dddd").is_dir());
        assert!(parent.join("unrelated").is_dir());
        assert!(parent.join("curl.backup-20260505-000000-eeee").is_file());

        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn update_refuses_when_the_target_folder_is_missing() {
        // Checked before any download, so this runs without touching the
        // network.
        let catalog = build_catalog(&[], &HashMap::new(), "deadbeef");
        let missing = std::env::temp_dir().join("pyshell-gone-xyz/main.py");
        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(update_in_place("bot-hunter", &missing, &catalog, None))
            .unwrap_err()
            .to_string();
        assert!(err.contains("relink"), "{}", err);
    }

    // --- Live network tests -------------------------------------------------
    //
    // Everything above is hermetic; these two hit the real GitHub API and are
    // ignored by default so `cargo test` stays offline-safe. Run explicitly:
    //   cargo test --manifest-path src-tauri/Cargo.toml repo:: -- --ignored
    // Together they cover the full store path: tree fetch, parallel manifest
    // fetch, catalog build, parallel file download, staging and atomic move.

    #[test]
    #[ignore = "hits the live GitHub API — run with `cargo test -- --ignored`"]
    fn live_catalog_lists_the_repo() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let catalog = rt.block_on(fetch_catalog()).unwrap();
        assert!(
            catalog.entries.len() >= 10,
            "expected the repo's scripts, got {}",
            catalog.entries.len()
        );
        for e in &catalog.entries {
            assert!(!e.id.is_empty(), "{} has no id", e.dir);
            assert!(e.files > 0, "{} has no files", e.dir);
            assert_eq!(e.name.trim(), e.name, "{} name needs no trimming", e.dir);
        }
        // The authoring reference must never appear as an installable script.
        assert!(!catalog.entries.iter().any(|e| e.dir == "_reference"));
    }

    #[test]
    #[ignore = "downloads real files from GitHub — run with `cargo test -- --ignored`"]
    fn live_install_downloads_the_smallest_folder() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let catalog = rt.block_on(fetch_catalog()).unwrap();
        let smallest = catalog
            .entries
            .iter()
            .min_by_key(|e| e.files)
            .expect("catalog is not empty");

        let dest = std::env::temp_dir().join(format!("pyshell-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dest).unwrap();
        let folder = rt
            .block_on(install(&smallest.dir, &dest, &catalog, None))
            .expect("install should succeed");

        assert_eq!(folder, dest.join(&smallest.dir));
        assert!(folder.join("pyshell.yaml").is_file(), "manifest must be there");
        // Every catalog file made it to disk: no partial download, and the
        // staging directory is gone (renamed, not copied).
        let on_disk = count_files(&folder);
        assert_eq!(on_disk, smallest.files as u64, "file count mismatch");
        assert!(!dest.join(format!(".{}.tmp", smallest.dir)).exists());

        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    #[ignore = "downloads real files from GitHub — run with `cargo test -- --ignored`"]
    fn live_update_replaces_the_folder_and_keeps_a_backup() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let catalog = rt.block_on(fetch_catalog()).unwrap();
        let smallest = catalog
            .entries
            .iter()
            .min_by_key(|e| e.files)
            .expect("catalog is not empty");

        let dest = std::env::temp_dir().join(format!("pyshell-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dest).unwrap();
        let folder = rt
            .block_on(install(&smallest.dir, &dest, &catalog, None))
            .expect("install should succeed");

        // A local edit, standing in for anything the user changed in the
        // folder since installing — it must survive in the backup.
        std::fs::write(folder.join("local-edit.txt"), b"mine").unwrap();

        let (target, backup) = rt
            .block_on(update_in_place(&smallest.dir, &folder, &catalog, None))
            .expect("update should succeed");

        assert_eq!(target, folder);
        // Fresh repo content is in place…
        assert!(target.join("pyshell.yaml").is_file());
        assert_eq!(count_files(&target), smallest.files as u64);
        assert!(!target.join("local-edit.txt").exists(), "fresh folder is exactly the repo");
        // …and the pre-update state — local edit included — is in the backup.
        assert!(backup.join("pyshell.yaml").is_file());
        assert!(backup.join("local-edit.txt").is_file());
        assert_ne!(backup, target);

        let _ = std::fs::remove_dir_all(&dest);
    }

    fn count_files(dir: &Path) -> u64 {
        let mut n = 0;
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                n += count_files(&path);
            } else {
                n += 1;
            }
        }
        n
    }

    // --- App update comparison ----------------------------------------------

    #[test]
    fn a_higher_component_is_an_update() {
        assert!(is_newer("0.3.1", "0.3.2"));
        assert!(is_newer("0.3.1", "0.4.0"));
        assert!(is_newer("0.9.9", "1.0.0"));
        assert!(is_newer("0.3.1", "0.10.0"), "components compare as numbers, not text");
    }

    #[test]
    fn the_same_or_older_version_is_not_an_update() {
        assert!(!is_newer("0.3.1", "0.3.1"));
        assert!(!is_newer("0.3.1", "0.3.0"));
        assert!(!is_newer("1.0.0", "0.9.9"));
    }

    #[test]
    fn the_tag_prefix_and_missing_components_do_not_matter() {
        assert!(is_newer("0.3.1", "v0.3.2"), "tags carry a v, package versions do not");
        assert!(is_newer("0.3.1", "0.4"), "a missing component reads as zero");
        assert!(!is_newer("0.4.0", "0.4"));
    }

    #[test]
    fn an_unreadable_version_never_offers_an_update() {
        // A hand-made tag must not turn into a permanent "update available".
        assert!(!is_newer("0.3.1", "nightly"));
        assert!(!is_newer("0.3.1", ""));
        assert!(!is_newer("0.3.1", "v"));
        assert!(!is_newer("", "0.4.0"));
    }

    #[test]
    fn a_prerelease_suffix_is_cut_before_comparing() {
        assert!(!is_newer("0.4.0", "v0.4.0-beta.1"));
        assert!(is_newer("0.3.1", "v0.4.0-beta.1"));
    }

    #[test]
    #[ignore = "hits the live GitHub API — run with `cargo test -- --ignored`"]
    fn live_latest_release_is_readable_or_absent() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        // `None` is a valid answer — every release of this repo may still be a
        // draft, which the API does not expose. Either way it must not error.
        if let Some(release) = rt.block_on(latest_release()).unwrap() {
            assert!(version_parts(&release.version).is_some(), "tag {} is not a version", release.version);
            assert!(release.url.starts_with("https://github.com/"), "unexpected url {}", release.url);
        }
    }
}
