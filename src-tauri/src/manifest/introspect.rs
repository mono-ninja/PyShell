use std::path::Path;

use super::model::{
    ArgStyle, Binding, ChoiceOption, InputSpec, InputType, Outputs, ResultKind, Runtime,
    ScriptSchema, SchemaSource,
};
use crate::error::{AppError, Result};

/// Introspect a Python script by running an introspector script in a
/// temporary venv. This is **arbitrary code execution** — see Plan.md §M7.
///
/// The caller must gate this behind a consent UI (same gate as pip install).
/// We run in a separate process, with a 10 s timeout, no secrets in env,
/// and `PYSHELL_INTROSPECT=1` so scripts can self-protect.
pub async fn introspect_script(path: &Path, venv_python: &Path) -> Result<ScriptSchema> {
    let introspector_code = include_str!("../../resources/introspect.py");

    let temp_dir = std::env::temp_dir().join(format!("pyshell-introspect-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir)?;
    let script_path = temp_dir.join("_introspect.py");
    std::fs::write(&script_path, introspector_code)?;

    let mut cmd = tokio::process::Command::new(venv_python);
    cmd.arg(&script_path)
        .arg(path)
        .env("PYSHELL_INTROSPECT", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // 10 second timeout (Plan.md §M7)
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        cmd.output(),
    )
    .await
    .map_err(|_| {
        let _ = std::fs::remove_dir_all(&temp_dir);
        AppError::Manifest("introspection timed out (10s limit)".to_string())
    })?
    .map_err(|e| {
        let _ = std::fs::remove_dir_all(&temp_dir);
        AppError::Manifest(format!("introspection spawn failed: {}", e))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(AppError::Manifest(format!(
            "introspection failed: {}",
            stderr.lines().take(5).collect::<Vec<_>>().join("\n")
        )));
    }

    // Enforce a response size limit (Plan.md §M7: "обмеження на розмір відповіді")
    const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024; // 10 MB
    if output.stdout.len() > MAX_RESPONSE_BYTES {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(AppError::Manifest(format!(
            "introspection output too large: {} bytes (max {} bytes)",
            output.stdout.len(),
            MAX_RESPONSE_BYTES
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let schema_json: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&temp_dir);
            AppError::Manifest(format!("introspection output parse error: {}", e))
        })?;

    let _ = std::fs::remove_dir_all(&temp_dir);

    schema_from_introspection(path, &schema_json)
}

fn schema_from_introspection(path: &Path, json: &serde_json::Value) -> Result<ScriptSchema> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let hash = super::yaml::sha256_hex(&canonical.to_string_lossy());
    let id = format!("local.{}", &hash[..16]);

    let name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());

    let inputs_json = json
        .get("inputs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut inputs = Vec::new();
    for inp_json in inputs_json {
        let key = inp_json
            .get("key")
            .and_then(|v| v.as_str())
            .unwrap_or("arg")
            .to_string();
        let label = inp_json
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or(&key)
            .to_string();
        let help = inp_json
            .get("help")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let flag = inp_json
            .get("flag")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let required = inp_json
            .get("required")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let default = inp_json.get("default").cloned();

        let input_type = guess_type(&inp_json);
        let binding = guess_binding(&flag, &inp_json);

        inputs.push(InputSpec {
            key,
            r#type: input_type,
            label,
            help,
            required,
            default,
            group: None,
            visible_if: None,
            binding,
        });
    }

    super::validate::validate(&inputs, None)?;

    Ok(ScriptSchema {
        schema: 1,
        id,
        name,
        version: None,
        description: None,
        icon: None,
        category: None,
        // Introspection and the fallback cannot see cross-script deps —
        // `needs` is a manifest-declared field only.
        needs: Vec::new(),
        runtime: Runtime {
            entry: path.to_path_buf(),
            python: ">=3.11".to_string(),
            requirements: None,
            timeout: None,
        },
        inputs,
        outputs: Outputs {
            artifacts: vec![],
            result: Some(ResultKind::None),
        },
        source: SchemaSource::Guessed,
    })
}

fn guess_type(json: &serde_json::Value) -> InputType {
    let type_str = json
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("str");

    // If choices are present, use Choice type regardless of the base type
    if let Some(choices) = json.get("choices").and_then(|v| v.as_array()) {
        if !choices.is_empty() {
            let options = choices
                .iter()
                .map(|v| ChoiceOption {
                    value: v.as_str().unwrap_or("unknown").to_string(),
                    label: None,
                })
                .collect();
            return InputType::Choice { options };
        }
    }

    match type_str {
        "int" => InputType::Int {
            min: None,
            max: None,
        },
        "float" => InputType::Float {
            min: None,
            max: None,
        },
        "bool" | "store_true" => InputType::Bool,
        "file" => InputType::File {
            extensions: vec![],
        },
        _ => InputType::String {
            pattern: None,
            max_len: None,
        },
    }
}

fn guess_binding(flag: &Option<String>, json: &serde_json::Value) -> Binding {
    let is_positional = json
        .get("positional")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if is_positional {
        let index = json
            .get("index")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        return Binding::Positional { index };
    }

    let flag = flag.clone().unwrap_or_else(|| "--arg".to_string());

    let is_flag = json
        .get("action")
        .and_then(|v| v.as_str())
        .map(|s| s == "store_true" || s == "store_false")
        .unwrap_or(false);

    if is_flag {
        Binding::Arg {
            flag,
            style: ArgStyle::Flag,
        }
    } else {
        Binding::Arg {
            flag,
            style: ArgStyle::Space,
        }
    }
}

/// Fallback: build a minimal schema for a script with no manifest and no
/// introspection (e.g. introspection not yet available because no venv).
pub fn fallback_schema(path: &Path) -> ScriptSchema {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let hash = super::yaml::sha256_hex(&canonical.to_string_lossy());
    let id = format!("local.{}", &hash[..16]);

    let name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());

    ScriptSchema {
        schema: 1,
        id,
        name,
        version: None,
        description: None,
        icon: None,
        category: None,
        // Introspection and the fallback cannot see cross-script deps —
        // `needs` is a manifest-declared field only.
        needs: Vec::new(),
        runtime: Runtime {
            entry: path.to_path_buf(),
            python: ">=3.11".to_string(),
            requirements: None,
            timeout: None,
        },
        inputs: vec![],
        outputs: Outputs {
            artifacts: vec![],
            result: Some(ResultKind::None),
        },
        source: SchemaSource::Fallback,
    }
}
