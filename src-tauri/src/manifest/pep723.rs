use std::path::Path;

use super::model::{InputSpec, Outputs, Runtime, ScriptSchema, SchemaSource};
use crate::error::{AppError, Result};

/// Extract a PEP 723 `# /// script` block from a Python file and parse the
/// `[tool.pyshell]` section from it.
pub fn parse_pep723(path: &Path) -> Result<Option<ScriptSchema>> {
    let content = std::fs::read_to_string(path)?;

    let block = match extract_script_block(&content) {
        Some(b) => b,
        None => return Ok(None),
    };

    // The block is TOML; parse and look for [tool.pyshell]
    let value: toml::Value = toml::from_str(&block)
        .map_err(|e| AppError::Manifest(format!("PEP 723 TOML parse error: {}", e)))?;

    let pyshell = value
        .get("tool")
        .and_then(|t| t.get("pyshell"));

    let pyshell = match pyshell {
        Some(v) => v,
        None => return Ok(None),
    };

    let id = pyshell
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            let hash = super::yaml::sha256_hex(&canonical.to_string_lossy());
            format!("local.{}", &hash[..16])
        });

    let name = pyshell
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "unnamed".to_string())
        });

    let python = pyshell
        .get("python")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| ">=3.11".to_string());

    let timeout = pyshell.get("timeout").and_then(|v| v.as_integer()).map(|i| i as u64);

    let inputs: Vec<InputSpec> = pyshell
        .get("inputs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let json = toml_to_json(v);
                    serde_json::from_value(json).ok()
                })
                .collect()
        })
        .unwrap_or_default();

    let outputs_json = pyshell
        .get("outputs")
        .map(toml_to_json)
        .unwrap_or(serde_json::json!({}));
    let outputs: Outputs = serde_json::from_value(outputs_json).unwrap_or_default();

    super::validate::validate(&inputs, None)?;

    Ok(Some(ScriptSchema {
        schema: 1,
        id,
        name,
        version: pyshell.get("version").and_then(|v| v.as_str()).map(|s| s.to_string()),
        description: pyshell.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
        icon: pyshell.get("icon").and_then(|v| v.as_str()).map(|s| s.to_string()),
        category: pyshell.get("category").and_then(|v| v.as_str()).map(|s| s.to_string()),
        runtime: Runtime {
            entry: path.to_path_buf(),
            python,
            requirements: None,
            timeout,
        },
        inputs,
        outputs,
        source: SchemaSource::Pep723,
    }))
}

/// Extract the content of a `# /// script` block (PEP 723).
fn extract_script_block(content: &str) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    let mut start = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed == "# /// script" {
            start = Some(i);
            break;
        }
    }

    let start = start?;

    let mut block_lines = Vec::new();
    for line in &lines[start + 1..] {
        let trimmed = line.trim_start();
        if trimmed == "# ///" {
            break;
        }
        // PEP 723: every line must start with "# " or be "#"
        if let Some(stripped) = line.strip_prefix("# ") {
            block_lines.push(stripped.to_string());
        } else if line.trim() == "#" {
            block_lines.push(String::new());
        } else {
            return None;
        }
    }

    Some(block_lines.join("\n"))
}

fn toml_to_json(v: &toml::Value) -> serde_json::Value {
    match v {
        toml::Value::String(s) => serde_json::Value::String(s.clone()),
        toml::Value::Integer(i) => serde_json::Value::Number((*i).into()),
        toml::Value::Float(f) => serde_json::json!(f),
        toml::Value::Boolean(b) => serde_json::Value::Bool(*b),
        toml::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(toml_to_json).collect())
        }
        toml::Value::Table(t) => {
            serde_json::Value::Object(t.iter().map(|(k, v)| (k.clone(), toml_to_json(v))).collect())
        }
        toml::Value::Datetime(d) => serde_json::Value::String(d.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::model::{ArgStyle, Binding, InputType};

    /// The PEP 723 parser drops any input it cannot deserialize
    /// (`filter_map(.. .ok())`), so a typo in an inline manifest silently removes
    /// a field from the form instead of failing. This pins the shipped example.
    #[test]
    fn test_parse_progress_demo_pep723() {
        let path = std::path::Path::new("../examples/progress-demo.py");
        if !path.exists() {
            eprintln!("Skipping test: {} not found", path.display());
            return;
        }

        let schema = parse_pep723(path)
            .expect("PEP 723 block should parse")
            .expect("example should have a PEP 723 manifest");

        assert_eq!(schema.id, "com.pyshell.example.progress");
        assert_eq!(schema.name, "Progress Demo");
        assert!(schema.description.is_some());

        // Every declared input must survive deserialization.
        let keys: Vec<&str> = schema.inputs.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, vec!["items", "fail_rate", "slow"], "an input was dropped");

        let items = &schema.inputs[0];
        assert!(matches!(items.r#type, InputType::Int { min: Some(1), max: Some(200000) }));
        assert_eq!(items.group.as_deref(), Some("Workload"));
        assert!(items.help.is_some(), "help text was dropped");
        assert_eq!(items.default, Some(serde_json::json!(2000)));
        match &items.binding {
            Binding::Arg { flag, style } => {
                assert_eq!(flag, "--items");
                assert!(matches!(style, ArgStyle::Space));
            }
            other => panic!("expected Arg, got {:?}", other),
        }

        // A bool must bind as a flag, or it would pass "--slow true".
        let slow = &schema.inputs[2];
        assert!(matches!(slow.r#type, InputType::Bool));
        assert_eq!(slow.default, Some(serde_json::json!(true)));
        match &slow.binding {
            Binding::Arg { flag, style } => {
                assert_eq!(flag, "--slow");
                assert!(matches!(style, ArgStyle::Flag), "bool must use style: flag");
            }
            other => panic!("expected Arg, got {:?}", other),
        }

        // Artifacts are what make the CSV show up in ResultView.
        assert_eq!(schema.outputs.artifacts, vec!["*.csv".to_string()]);
    }

    /// Same guard for the chart/markdown example. `choice` options and
    /// `outputs.result` are the parts most likely to be dropped silently: both
    /// are nested structures, and a dropped `result` only shows up as a missing
    /// badge on the Results tab.
    #[test]
    fn test_parse_report_demo_pep723() {
        let path = std::path::Path::new("../examples/report-demo.py");
        if !path.exists() {
            eprintln!("Skipping test: {} not found", path.display());
            return;
        }

        let schema = parse_pep723(path)
            .expect("PEP 723 block should parse")
            .expect("example should have a PEP 723 manifest");

        assert_eq!(schema.id, "com.pyshell.example.report");
        assert_eq!(schema.name, "Report Demo");

        let keys: Vec<&str> = schema.inputs.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, vec!["samples", "final_chart", "slow"], "an input was dropped");

        // The declared result kind is what labels the Results tab before a run.
        assert!(
            matches!(schema.outputs.result, Some(crate::manifest::model::ResultKind::Markdown)),
            "outputs.result was dropped: {:?}",
            schema.outputs.result
        );

        // Inline-table options are the easiest thing to get wrong in TOML.
        let final_chart = &schema.inputs[1];
        match &final_chart.r#type {
            InputType::Choice { options } => {
                let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
                assert_eq!(values, vec!["bar", "line"]);
                assert!(options.iter().all(|o| o.label.is_some()), "a label was dropped");
            }
            other => panic!("expected Choice, got {:?}", other),
        }
        assert_eq!(final_chart.default, Some(serde_json::json!("bar")));

        // A bool must bind as a flag, or argparse gets "--slow true".
        let slow = &schema.inputs[2];
        assert!(matches!(slow.r#type, InputType::Bool));
        match &slow.binding {
            Binding::Arg { flag, style } => {
                assert_eq!(flag, "--slow");
                assert!(matches!(style, ArgStyle::Flag), "bool must use style: flag");
            }
            other => panic!("expected Arg, got {:?}", other),
        }
    }
}
