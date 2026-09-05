use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ScriptSchema {
    pub schema: u8,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Other PyShell scripts this one expects to be installed, by manifest id
    /// (`com.pyshell.sitecrawler`). Declared, never enforced: the header shows
    /// a pill for missing ones, the Store installs them along, and at run time
    /// each installed dependency's folder is exposed via the `PYSHELL_DEPS`
    /// env var. Empty for the overwhelming majority of scripts, hence skipped
    /// in serialization — old saved schemas and generated manifests stay
    /// byte-identical.
    ///
    /// The `#[ts(type)]` override keeps the generated binding honest about
    /// that skip: over IPC the field is *absent* (undefined), never an empty
    /// array — the same wire reality `description` has always had, except the
    /// type now says so and the compiler enforces the guard.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(type = "Array<string> | undefined")]
    pub needs: Vec<String>,
    pub runtime: Runtime,
    pub inputs: Vec<InputSpec>,
    pub outputs: Outputs,
    #[serde(deserialize_with = "deserialize_source", default)]
    pub source: SchemaSource,
}

/// Backward-compatible deserializer for [`SchemaSource`]. Maps the legacy
/// `"introspected"` value (from before the enum was split into `Fallback` /
/// `Guessed`) to `Guessed`, and unknown values to `Fallback`.
fn deserialize_source<'de, D>(deserializer: D) -> std::result::Result<SchemaSource, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    match s.as_str() {
        "yaml" => Ok(SchemaSource::Yaml),
        "pep723" => Ok(SchemaSource::Pep723),
        "fallback" => Ok(SchemaSource::Fallback),
        "guessed" => Ok(SchemaSource::Guessed),
        "introspected" => Ok(SchemaSource::Guessed),
        _ => Ok(SchemaSource::Fallback),
    }
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum SchemaSource {
    Yaml,
    Pep723,
    #[default]
    Fallback,
    Guessed,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct Runtime {
    pub entry: PathBuf,
    pub python: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirements: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub timeout: Option<u64>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct InputSpec {
    pub key: String,
    #[serde(flatten)]
    pub r#type: InputType,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "any")]
    pub default: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_if: Option<Condition>,
    pub binding: Binding,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum InputType {
    String {
        #[serde(skip_serializing_if = "Option::is_none")]
        pattern: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_len: Option<usize>,
    },
    Multiline,
    Int {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        min: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        max: Option<i64>,
    },
    Float {
        #[serde(skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
    },
    Bool,
    Choice {
        options: Vec<ChoiceOption>,
    },
    MultiChoice {
        options: Vec<ChoiceOption>,
    },
    File {
        extensions: Vec<String>,
    },
    Files {
        extensions: Vec<String>,
    },
    Dir,
    SavePath {
        #[serde(skip_serializing_if = "Option::is_none")]
        default_name: Option<String>,
    },
    Secret,
    Date,
    Url,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ChoiceOption {
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum Binding {
    Arg {
        flag: String,
        #[serde(flatten)]
        style: ArgStyle,
    },
    Env {
        name: String,
    },
    Stdin,
    TempFile {
        flag: String,
    },
    Positional {
        index: usize,
    },
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "style", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum ArgStyle {
    Space,
    Equals,
    Flag,
    Repeat,
    Joined {
        sep: String,
    },
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum Condition {
    Eq {
        key: String,
        #[ts(type = "any")]
        value: serde_json::Value,
    },
    Ne {
        key: String,
        #[ts(type = "any")]
        value: serde_json::Value,
    },
    Truthy { key: String },
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, Default)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct Outputs {
    #[serde(default)]
    pub artifacts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ResultKind>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum ResultKind {
    Table,
    Markdown,
    None,
}

// --- API types ---

/// One installable script from the community repo (the Script Store).
///
/// The listing fields (`name`, `description`, `icon`, `category`) come from the
/// folder's `pyshell.yaml` in the repo, so the store shows exactly what the
/// script will look like once imported. `dir` is the folder name inside the
/// repo ("bot-hunter"), and `id` is the manifest id ("com.pyshell.bothunter")
/// — the same id an imported `ScriptEntry` carries, which is how the frontend
/// marks a store entry as already installed.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct RepoScript {
    /// Folder name inside the repo; also the name of the local folder created
    /// in the user-chosen destination.
    pub dir: String,
    /// Manifest id — matches `ScriptEntry::id` after import.
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Other store scripts this one needs, by manifest id — so one Install can
    /// pull them in (`install_closure` in `repo.rs`). Absent over IPC when
    /// empty (serde skip + the `#[ts(type)]` override, same reasoning as
    /// `ScriptSchema::needs`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(type = "Array<string> | undefined")]
    pub needs: Vec<String>,
    /// File count inside the repo folder (informational, shown in the store).
    #[ts(type = "number")]
    pub files: u64,
    /// Total size of the folder's files (informational, shown in the store).
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// Version of the *imported* script with the same id, filled in by
    /// `repo_catalog` when it hands the catalog to the frontend (the cached
    /// catalog itself stays pure). `None` when the script is not installed or
    /// its manifest declares no version — the frontend compares it with
    /// `version` to offer an Update. `#[ts(optional = nullable)]` because
    /// `skip_serializing_if` makes the field *absent* over IPC, not `null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub installed_version: Option<String>,
}

/// A published GitHub release of PyShell itself, as offered by the update
/// check.
///
/// This is a **notice, not an installer**: the app ships no updater signing
/// key, so `url` is the release page a user is sent to in their browser to
/// download the .dmg by hand. See `repo::latest_release`.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct AppRelease {
    /// Version without the tag's `v` prefix, e.g. `0.4.0`.
    pub version: String,
    /// The release page on github.com.
    pub url: String,
}

/// What one Store install produced: the requested script plus any of its
/// dependencies that were missing and got pulled in alongside. The dialog
/// selects `entry` and mentions `extras` in its toast.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct RepoInstallResult {
    pub entry: ScriptEntry,
    pub extras: Vec<ScriptEntry>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ScriptEntry {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// The script's declared dependencies, synced from the schema at import
    /// and reload the same way `name`/`icon`/`category` are — the sidebar
    /// shows a chain marker for them without loading every schema.
    ///
    /// Absent over IPC when empty (serde skip + the `#[ts(type)]` override —
    /// the wire reality the `needs.filter` crash taught us about).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(type = "Array<string> | undefined")]
    pub needs: Vec<String>,
    pub path: PathBuf,
    #[serde(deserialize_with = "deserialize_source", default)]
    pub source: SchemaSource,
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_error: Option<String>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum EnvStatus {
    Ready {
        #[ts(type = "number")]
        size_bytes: u64,
        python: String,
    },
    Missing,
    Stale { reason: String },
    Building { pct: f32, phase: String },
    Failed { message: String },
}

/// Payload of the `env:{id}:progress` global event, emitted once per phase of
/// an env build. Generated here (rather than hand-written on the frontend) so
/// the IPC shape is pinned by the same ts-rs pipeline as everything else.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct EnvProgress {
    pub phase: String,
    #[ts(type = "number")]
    pub pct: f32,
    pub message: String,
}

/// A script's own source code, as shown by the "Show Code" viewer.
///
/// The path is resolved in Rust from the script list — the frontend never
/// sends one — which is also what lets the viewer read scripts that live
/// outside the fs plugin's scope (scripts are referenced in place, so they
/// can sit anywhere on disk).
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ScriptSource {
    pub name: String,
    pub path: PathBuf,
    pub content: String,
}

/// One secret stored in the OS keychain, as listed by Settings ▸ Secrets.
///
/// The *value* is deliberately not part of this type — it never leaves the
/// keychain. `set_at` is known only when PyShell itself recorded the write
/// (entries that predate the registry list as `None`).
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct SecretEntry {
    pub script_id: String,
    pub key: String,
    /// RFC 3339 timestamp of when the value was (last) written, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub set_at: Option<String>,
}

/// User-tunable application settings, persisted at `{app_support}/settings.json`.
///
/// `retention_runs` governs **both** the History entries and the run output
/// folders on disk, so the two can never disagree about which runs still exist
/// (the History tab offers Log/Files for exactly the runs whose folder is
/// there).
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct AppSettings {
    #[serde(default = "default_retention_runs")]
    #[ts(type = "number")]
    pub retention_runs: usize,
}

fn default_retention_runs() -> usize {
    50
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            retention_runs: default_retention_runs(),
        }
    }
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct DiskUsage {
    #[ts(type = "number")]
    pub total_bytes: u64,
    #[ts(type = "number")]
    pub uv_cache_bytes: u64,
    #[ts(type = "number")]
    pub output_bytes: u64,
    pub per_script: Vec<(String, u64)>,
    #[ts(type = "number")]
    pub orphaned_bytes: u64,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct Artifact {
    pub path: PathBuf,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, Default)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ScriptState {
    #[serde(default)]
    #[ts(type = "Record<string, any>")]
    pub last_values: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub presets: Vec<Preset>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct Preset {
    pub name: String,
    #[ts(type = "Record<string, any>")]
    pub values: HashMap<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct HistoryEntry {
    pub timestamp: String,
    /// The job that produced this entry. `None` for entries written before this
    /// field existed, or if the run dir has been pruned by retention. The UI
    /// uses it to offer "Open log" / "Artifacts" for past runs (Plan.md §1.2).
    #[serde(default)]
    pub job_id: Option<String>,
    #[ts(type = "Record<string, any>")]
    pub values: HashMap<String, serde_json::Value>,
    pub exit_code: Option<i32>,
    #[ts(type = "number")]
    pub duration_ms: u64,
}

// --- Runner types ---

pub type JobId = String;

/// One translation of a script's document, as offered by the language switcher.
///
/// `lang` is the suffix from the filename — `pyshell_ua.md` yields `Some("ua")`
/// — and `None` is the unsuffixed file, which is the default the panel opens
/// with. The code is whatever the author wrote; PyShell does not validate it
/// against a locale list, so an author is free to use `ua`, `uk` or `pt-br`.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct DocVariant {
    pub lang: Option<String>,
    pub name: String,
}

/// A README found next to a script, handed to the frontend for display.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ScriptDoc {
    pub name: String,
    pub path: PathBuf,
    pub content: String,
    /// Language of *this* document; `None` for the unsuffixed file.
    pub lang: Option<String>,
    /// Every language the document exists in, including this one. One entry
    /// means there is nothing to switch between and the panel hides the picker.
    pub variants: Vec<DocVariant>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct LogLine {
    pub stream: String,
    pub text: String,
    #[ts(type = "number")]
    pub ts: u64,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum JobEvent {
    Lines { batch: Vec<LogLine> },
    Structured {
        #[ts(type = "any")]
        event: serde_json::Value,
    },
    Exit {
        code: Option<i32>,
        #[ts(type = "number")]
        duration_ms: u64,
        reason: ExitReason,
    },
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/types/bindings/")]
pub enum ExitReason {
    Ok,
    Error,
    Cancelled,
    Timeout,
    Killed,
}
