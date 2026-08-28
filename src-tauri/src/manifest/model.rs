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

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export, export_to = "../../src/types/bindings/")]
pub struct ScriptEntry {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
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
