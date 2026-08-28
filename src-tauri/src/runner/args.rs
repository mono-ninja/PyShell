use std::collections::HashMap;
use std::path::PathBuf;

use crate::manifest::model::{ArgStyle, Binding, Condition, InputSpec, InputType, ScriptSchema};

/// Result of converting form values + schema into process inputs.
pub struct ProcessInputs {
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
    pub stdin: Option<String>,
    pub temp_files: Vec<PathBuf>,
}

/// Convert form values + schema into (argv, env, stdin, temp_files).
///
/// This is a pure function and holds ~80% of the bugs (Plan.md §M3).
/// Snapshot-test every ArgStyle, Positional, Flag=false, empty MultiChoice,
/// and values with spaces/quotes.
pub fn build_process_inputs(
    schema: &ScriptSchema,
    values: &HashMap<String, serde_json::Value>,
    secrets: &HashMap<String, String>,
) -> ProcessInputs {
    let mut argv: Vec<String> = Vec::new();
    let mut env: HashMap<String, String> = HashMap::new();
    let mut stdin: Option<String> = None;
    let mut temp_files: Vec<PathBuf> = Vec::new();
    let mut positional: Vec<(usize, String)> = Vec::new();

    for input in &schema.inputs {
        // A field hidden by `visible_if` must not reach the process. The form
        // still sends its value (last_values and presets keep it so toggling
        // back restores what the user typed), so the filtering has to happen
        // here — the UI only decides what to *draw*.
        //
        // A hidden positional is simply skipped, which closes the gap it would
        // have left: there is no way to pass a hole in a positional list.
        if !is_visible(input, values) {
            continue;
        }

        let value = values.get(&input.key);
        let secret_value = secrets.get(&input.key);

        match &input.binding {
            Binding::Arg { flag, style } => {
                // Secrets are validated to never use Binding::Arg (Plan.md §0).
                // If we get here, it's a regular (non-secret) input.
                if let InputType::Secret = input.r#type {
                    tracing::error!(
                        "Secret input '{}' has Binding::Arg — this should have been caught by validation. Skipping.",
                        input.key
                    );
                } else {
                    append_arg(
                        &input.r#type,
                        flag,
                        style,
                        value,
                        &mut argv,
                        &mut temp_files,
                        input.key.as_str(),
                    );
                }
            }
            Binding::Env { name } => {
                if let InputType::Secret = input.r#type {
                    if let Some(s) = secret_value {
                        env.insert(name.clone(), s.clone());
                    }
                } else if let Some(v) = value {
                    if let Some(s) = json_to_string(v) {
                        env.insert(name.clone(), s);
                    }
                }
            }
            Binding::Stdin => {
                // Secrets never reach the frontend, so `value` only ever holds
                // the "__secret_set__" sentinel — the real value comes from the
                // keychain. `validate.rs` accepts secret + stdin (and its error
                // message recommends it), so it has to work here.
                if let InputType::Secret = input.r#type {
                    if let Some(s) = secret_value {
                        stdin = Some(s.clone());
                    }
                } else if let Some(v) = value {
                    stdin = Some(json_to_string(v).unwrap_or_default());
                }
            }
            Binding::TempFile { flag } => {
                if let Some(v) = value {
                    let content = json_to_string(v).unwrap_or_default();
                    let temp = std::env::temp_dir().join(format!("pyshell_{}.tmp", uuid::Uuid::new_v4()));
                    let _ = std::fs::write(&temp, &content);
                    temp_files.push(temp.clone());
                    argv.push(flag.clone());
                    argv.push(temp.to_string_lossy().to_string());
                }
            }
            Binding::Positional { index } => {
                if let Some(v) = value {
                    if let Some(s) = json_to_string(v) {
                        positional.push((*index, s));
                    }
                }
            }
        }
    }

    // Sort positionals by index and append
    positional.sort_by_key(|(i, _)| *i);
    for (_, s) in positional {
        argv.push(s);
    }

    ProcessInputs {
        argv,
        env,
        stdin,
        temp_files,
    }
}

#[allow(clippy::too_many_arguments)]
fn append_arg(
    input_type: &InputType,
    flag: &str,
    style: &ArgStyle,
    value: Option<&serde_json::Value>,
    argv: &mut Vec<String>,
    _temp_files: &mut Vec<PathBuf>,
    _key: &str,
) {
    match style {
        ArgStyle::Flag => {
            // Only add the flag when value is true
            if let Some(serde_json::Value::Bool(true)) = value {
                argv.push(flag.to_string());
            }
        }
        ArgStyle::Space => {
            if let Some(s) = value.and_then(json_to_string) {
                if !s.is_empty() || matches!(input_type, InputType::String { .. } | InputType::Multiline) {
                    argv.push(flag.to_string());
                    argv.push(s);
                }
            }
        }
        ArgStyle::Equals => {
            if let Some(s) = value.and_then(json_to_string) {
                if !s.is_empty() || matches!(input_type, InputType::String { .. } | InputType::Multiline) {
                    argv.push(format!("{}={}", flag, s));
                }
            }
        }
        ArgStyle::Repeat => {
            // For MultiChoice: repeat the flag for each value
            if let Some(serde_json::Value::Array(arr)) = value {
                for v in arr {
                    if let Some(s) = json_to_string(v) {
                        argv.push(flag.to_string());
                        argv.push(s);
                    }
                }
            }
        }
        ArgStyle::Joined { sep } => {
            if let Some(serde_json::Value::Array(arr)) = value {
                let parts: Vec<String> = arr.iter().filter_map(json_to_string).collect();
                if !parts.is_empty() {
                    argv.push(flag.to_string());
                    argv.push(parts.join(sep));
                }
            } else if let Some(s) = value.and_then(json_to_string) {
                argv.push(flag.to_string());
                argv.push(s);
            }
        }
    }
}

/// Whether an input is visible given the current form values.
///
/// This mirrors `isFieldVisible` in `src/components/Form/field-utils.ts` and
/// must stay in step with it: the UI decides what to draw from the same rule,
/// and `validateForm` skips hidden fields, so a divergence would let the form
/// pass validation while the process gets different arguments.
///
/// Like the UI, only the field's own condition is evaluated — visibility does
/// not cascade through a chain of hidden parents.
pub fn is_visible(input: &InputSpec, values: &HashMap<String, serde_json::Value>) -> bool {
    let Some(cond) = &input.visible_if else {
        return true;
    };

    match cond {
        Condition::Eq { key, value } => equals(values.get(key), value),
        Condition::Ne { key, value } => !equals(values.get(key), value),
        Condition::Truthy { key } => truthy(values.get(key)),
    }
}

/// Mirrors the UI's `deepEqual(values[key], expected)`. A key that is absent
/// compares as `undefined`, which is never equal to anything — including `null`.
fn equals(actual: Option<&serde_json::Value>, expected: &serde_json::Value) -> bool {
    match actual {
        None => false,
        // Compare numbers numerically: the manifest may carry `1` where the form
        // sends `1.0`, which serde_json would otherwise treat as different.
        Some(serde_json::Value::Number(a)) => match (a.as_f64(), expected.as_f64()) {
            (Some(a), Some(b)) => a == b,
            _ => actual == Some(expected),
        },
        Some(a) => a == expected,
    }
}

/// Mirrors the UI's `truthy` branch: empty string, zero, empty array and
/// missing/null are all falsy.
fn truthy(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => !s.is_empty(),
        Some(serde_json::Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Some(serde_json::Value::Array(a)) => !a.is_empty(),
        Some(serde_json::Value::Object(_)) => true,
    }
}

pub fn json_to_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().filter_map(json_to_string).collect();
            Some(parts.join(","))
        }
        serde_json::Value::Object(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::model::*;
    use serde_json::json;

    fn make_schema(inputs: Vec<InputSpec>) -> ScriptSchema {
        ScriptSchema {
            schema: 1,
            id: "test".to_string(),
            name: "test".to_string(),
            version: None,
            description: None,
            icon: None,
            category: None,
            runtime: Runtime {
                entry: PathBuf::from("test.py"),
                python: ">=3.11".to_string(),
                requirements: None,
                timeout: None,
            },
            inputs,
            outputs: Outputs {
                artifacts: vec![],
                result: None,
            },
            source: SchemaSource::Yaml,
        }
    }

    fn make_input(key: &str, input_type: InputType, binding: Binding) -> InputSpec {
        InputSpec {
            key: key.to_string(),
            r#type: input_type,
            label: key.to_string(),
            help: None,
            required: false,
            default: None,
            group: None,
            visible_if: None,
            binding,
        }
    }

    fn run(schema: &ScriptSchema, values: &[(&str, serde_json::Value)]) -> Vec<String> {
        let values: HashMap<String, serde_json::Value> = values
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        let secrets = HashMap::new();
        build_process_inputs(schema, &values, &secrets).argv
    }

    #[test]
    fn test_arg_space() {
        let schema = make_schema(vec![make_input(
            "url",
            InputType::String { pattern: None, max_len: None },
            Binding::Arg {
                flag: "--url".to_string(),
                style: ArgStyle::Space,
            },
        )]);
        let argv = run(&schema, &[("url", json!("https://example.com"))]);
        assert_eq!(argv, vec!["--url", "https://example.com"]);
    }

    #[test]
    fn test_arg_equals() {
        let schema = make_schema(vec![make_input(
            "url",
            InputType::String { pattern: None, max_len: None },
            Binding::Arg {
                flag: "--url".to_string(),
                style: ArgStyle::Equals,
            },
        )]);
        let argv = run(&schema, &[("url", json!("https://example.com"))]);
        assert_eq!(argv, vec!["--url=https://example.com"]);
    }

    #[test]
    fn test_arg_flag_true() {
        let schema = make_schema(vec![make_input(
            "verbose",
            InputType::Bool,
            Binding::Arg {
                flag: "--verbose".to_string(),
                style: ArgStyle::Flag,
            },
        )]);
        let argv = run(&schema, &[("verbose", json!(true))]);
        assert_eq!(argv, vec!["--verbose"]);
    }

    #[test]
    fn test_arg_flag_false() {
        let schema = make_schema(vec![make_input(
            "verbose",
            InputType::Bool,
            Binding::Arg {
                flag: "--verbose".to_string(),
                style: ArgStyle::Flag,
            },
        )]);
        let argv = run(&schema, &[("verbose", json!(false))]);
        assert!(argv.is_empty());
    }

    #[test]
    fn test_arg_repeat() {
        let schema = make_schema(vec![make_input(
            "tags",
            InputType::MultiChoice {
                options: vec![
                    ChoiceOption { value: "a".into(), label: None },
                    ChoiceOption { value: "b".into(), label: None },
                ],
            },
            Binding::Arg {
                flag: "--tag".to_string(),
                style: ArgStyle::Repeat,
            },
        )]);
        let argv = run(&schema, &[("tags", json!(["a", "b"]))]);
        assert_eq!(argv, vec!["--tag", "a", "--tag", "b"]);
    }

    #[test]
    fn test_arg_joined() {
        let schema = make_schema(vec![make_input(
            "tags",
            InputType::MultiChoice {
                options: vec![
                    ChoiceOption { value: "a".into(), label: None },
                    ChoiceOption { value: "b".into(), label: None },
                ],
            },
            Binding::Arg {
                flag: "--tags".to_string(),
                style: ArgStyle::Joined { sep: ",".to_string() },
            },
        )]);
        let argv = run(&schema, &[("tags", json!(["a", "b"]))]);
        assert_eq!(argv, vec!["--tags", "a,b"]);
    }

    #[test]
    fn test_positional() {
        let schema = make_schema(vec![
            make_input(
                "input_file",
                InputType::File { extensions: vec![] },
                Binding::Positional { index: 0 },
            ),
            make_input(
                "output_file",
                InputType::SavePath { default_name: None },
                Binding::Positional { index: 1 },
            ),
        ]);
        let argv = run(&schema, &[
            ("input_file", json!("/tmp/in.csv")),
            ("output_file", json!("/tmp/out.csv")),
        ]);
        assert_eq!(argv, vec!["/tmp/in.csv", "/tmp/out.csv"]);
    }

    #[test]
    fn test_empty_multichoice() {
        let schema = make_schema(vec![make_input(
            "tags",
            InputType::MultiChoice {
                options: vec![ChoiceOption { value: "a".into(), label: None }],
            },
            Binding::Arg {
                flag: "--tag".to_string(),
                style: ArgStyle::Repeat,
            },
        )]);
        let argv = run(&schema, &[("tags", json!([]))]);
        assert!(argv.is_empty());
    }

    #[test]
    fn test_value_with_spaces() {
        let schema = make_schema(vec![make_input(
            "name",
            InputType::String { pattern: None, max_len: None },
            Binding::Arg {
                flag: "--name".to_string(),
                style: ArgStyle::Space,
            },
        )]);
        let argv = run(&schema, &[("name", json!("hello world"))]);
        assert_eq!(argv, vec!["--name", "hello world"]);
    }

    #[test]
    fn test_value_with_quotes() {
        let schema = make_schema(vec![make_input(
            "msg",
            InputType::String { pattern: None, max_len: None },
            Binding::Arg {
                flag: "--msg".to_string(),
                style: ArgStyle::Space,
            },
        )]);
        let argv = run(&schema, &[("msg", json!("say \"hello\""))]);
        assert_eq!(argv, vec!["--msg", "say \"hello\""]);
    }

    // --- Insta snapshot tests (Plan.md §M3) ---
    // These are the cheapest and most valuable tests in the project.

    #[test]
    fn snapshot_arg_space() {
        let schema = make_schema(vec![make_input(
            "url",
            InputType::String { pattern: None, max_len: None },
            Binding::Arg { flag: "--url".into(), style: ArgStyle::Space },
        )]);
        let argv = run(&schema, &[("url", json!("https://example.com"))]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_arg_equals() {
        let schema = make_schema(vec![make_input(
            "url",
            InputType::String { pattern: None, max_len: None },
            Binding::Arg { flag: "--url".into(), style: ArgStyle::Equals },
        )]);
        let argv = run(&schema, &[("url", json!("https://example.com"))]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_arg_flag_true() {
        let schema = make_schema(vec![make_input(
            "verbose",
            InputType::Bool,
            Binding::Arg { flag: "--verbose".into(), style: ArgStyle::Flag },
        )]);
        let argv = run(&schema, &[("verbose", json!(true))]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_arg_flag_false() {
        let schema = make_schema(vec![make_input(
            "verbose",
            InputType::Bool,
            Binding::Arg { flag: "--verbose".into(), style: ArgStyle::Flag },
        )]);
        let argv = run(&schema, &[("verbose", json!(false))]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_arg_repeat() {
        let schema = make_schema(vec![make_input(
            "tags",
            InputType::MultiChoice {
                options: vec![
                    ChoiceOption { value: "a".into(), label: None },
                    ChoiceOption { value: "b".into(), label: None },
                ],
            },
            Binding::Arg { flag: "--tag".into(), style: ArgStyle::Repeat },
        )]);
        let argv = run(&schema, &[("tags", json!(["a", "b"]))]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_arg_joined() {
        let schema = make_schema(vec![make_input(
            "tags",
            InputType::MultiChoice {
                options: vec![
                    ChoiceOption { value: "a".into(), label: None },
                    ChoiceOption { value: "b".into(), label: None },
                ],
            },
            Binding::Arg { flag: "--tags".into(), style: ArgStyle::Joined { sep: ",".into() } },
        )]);
        let argv = run(&schema, &[("tags", json!(["a", "b"]))]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_positional() {
        let schema = make_schema(vec![
            make_input(
                "input_file",
                InputType::File { extensions: vec![] },
                Binding::Positional { index: 0 },
            ),
            make_input(
                "output_file",
                InputType::SavePath { default_name: None },
                Binding::Positional { index: 1 },
            ),
        ]);
        let argv = run(&schema, &[
            ("input_file", json!("/tmp/in.csv")),
            ("output_file", json!("/tmp/out.csv")),
        ]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_empty_multichoice() {
        let schema = make_schema(vec![make_input(
            "tags",
            InputType::MultiChoice {
                options: vec![ChoiceOption { value: "a".into(), label: None }],
            },
            Binding::Arg { flag: "--tag".into(), style: ArgStyle::Repeat },
        )]);
        let argv = run(&schema, &[("tags", json!([]))]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_value_with_spaces() {
        let schema = make_schema(vec![make_input(
            "name",
            InputType::String { pattern: None, max_len: None },
            Binding::Arg { flag: "--name".into(), style: ArgStyle::Space },
        )]);
        let argv = run(&schema, &[("name", json!("hello world"))]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_value_with_quotes() {
        let schema = make_schema(vec![make_input(
            "msg",
            InputType::String { pattern: None, max_len: None },
            Binding::Arg { flag: "--msg".into(), style: ArgStyle::Space },
        )]);
        let argv = run(&schema, &[("msg", json!("say \"hello\""))]);
        insta::assert_debug_snapshot!(argv);
    }

    #[test]
    fn snapshot_env_binding() {
        let schema = make_schema(vec![make_input(
            "api_key",
            InputType::String { pattern: None, max_len: None },
            Binding::Env { name: "API_KEY".into() },
        )]);
        let values: HashMap<String, serde_json::Value> =
            [("api_key".to_string(), json!("secret123"))].into_iter().collect();
        let secrets = HashMap::new();
        let inputs = build_process_inputs(&schema, &values, &secrets);
        insta::assert_debug_snapshot!(inputs.env);
    }

    #[test]
    fn snapshot_stdin_binding() {
        let schema = make_schema(vec![make_input(
            "data",
            InputType::Multiline,
            Binding::Stdin,
        )]);
        let values: HashMap<String, serde_json::Value> =
            [("data".to_string(), json!("line1\nline2\nline3"))].into_iter().collect();
        let secrets = HashMap::new();
        let inputs = build_process_inputs(&schema, &values, &secrets);
        insta::assert_debug_snapshot!(inputs.stdin);
    }

    // --- visible_if must gate what reaches the process, not just the UI ---

    fn with_visible_if(mut input: InputSpec, cond: Condition) -> InputSpec {
        input.visible_if = Some(cond);
        input
    }

    /// `mode` drives whether `--advanced` is passed.
    fn conditional_schema(cond: Condition) -> ScriptSchema {
        make_schema(vec![
            make_input(
                "mode",
                InputType::Choice {
                    options: vec![
                        ChoiceOption { value: "simple".into(), label: None },
                        ChoiceOption { value: "advanced".into(), label: None },
                    ],
                },
                Binding::Arg { flag: "--mode".into(), style: ArgStyle::Space },
            ),
            with_visible_if(
                make_input(
                    "advanced",
                    InputType::String { pattern: None, max_len: None },
                    Binding::Arg { flag: "--advanced".into(), style: ArgStyle::Space },
                ),
                cond,
            ),
        ])
    }

    #[test]
    fn a_hidden_field_does_not_reach_argv() {
        let schema = conditional_schema(Condition::Eq {
            key: "mode".into(),
            value: json!("advanced"),
        });
        // The form still carries the value the user typed earlier; it must not
        // be passed while the field is hidden.
        let argv = run(&schema, &[("mode", json!("simple")), ("advanced", json!("leftover"))]);
        assert_eq!(argv, vec!["--mode", "simple"]);
    }

    #[test]
    fn a_visible_field_still_reaches_argv() {
        let schema = conditional_schema(Condition::Eq {
            key: "mode".into(),
            value: json!("advanced"),
        });
        let argv = run(&schema, &[("mode", json!("advanced")), ("advanced", json!("x"))]);
        assert_eq!(argv, vec!["--mode", "advanced", "--advanced", "x"]);
    }

    #[test]
    fn ne_hides_when_the_value_matches() {
        let schema = conditional_schema(Condition::Ne {
            key: "mode".into(),
            value: json!("simple"),
        });
        let hidden = run(&schema, &[("mode", json!("simple")), ("advanced", json!("x"))]);
        assert_eq!(hidden, vec!["--mode", "simple"]);

        let shown = run(&schema, &[("mode", json!("advanced")), ("advanced", json!("x"))]);
        assert_eq!(shown, vec!["--mode", "advanced", "--advanced", "x"]);
    }

    #[test]
    fn truthy_treats_empty_and_zero_as_hidden() {
        let schema = conditional_schema(Condition::Truthy { key: "mode".into() });

        for falsy in [json!(""), json!(false), json!(0), json!([]), json!(null)] {
            let argv = run(&schema, &[("mode", falsy.clone()), ("advanced", json!("x"))]);
            assert!(
                !argv.contains(&"--advanced".to_string()),
                "{:?} should be falsy, got {:?}",
                falsy,
                argv
            );
        }

        for t in [json!("yes"), json!(true), json!(1), json!(["a"])] {
            let argv = run(&schema, &[("mode", t.clone()), ("advanced", json!("x"))]);
            assert!(
                argv.contains(&"--advanced".to_string()),
                "{:?} should be truthy, got {:?}",
                t,
                argv
            );
        }
    }

    #[test]
    fn a_missing_referenced_key_hides_eq_and_shows_ne() {
        // Mirrors the UI: deepEqual(undefined, x) is false, so eq hides and ne shows.
        let eq = conditional_schema(Condition::Eq { key: "mode".into(), value: json!("advanced") });
        assert_eq!(run(&eq, &[("advanced", json!("x"))]), Vec::<String>::new());

        let ne = conditional_schema(Condition::Ne { key: "mode".into(), value: json!("advanced") });
        assert_eq!(run(&ne, &[("advanced", json!("x"))]), vec!["--advanced", "x"]);
    }

    #[test]
    fn eq_compares_numbers_numerically() {
        // The manifest may carry `1` where the form sends `1.0`.
        let schema = conditional_schema(Condition::Eq { key: "mode".into(), value: json!(1) });
        let argv = run(&schema, &[("mode", json!(1.0)), ("advanced", json!("x"))]);
        assert!(argv.contains(&"--advanced".to_string()), "got {:?}", argv);
    }

    #[test]
    fn hiding_a_positional_skips_it_rather_than_leaving_a_hole() {
        let schema = make_schema(vec![
            make_input("a", InputType::String { pattern: None, max_len: None }, Binding::Positional { index: 0 }),
            with_visible_if(
                make_input("b", InputType::String { pattern: None, max_len: None }, Binding::Positional { index: 1 }),
                Condition::Truthy { key: "never".into() },
            ),
            make_input("c", InputType::String { pattern: None, max_len: None }, Binding::Positional { index: 2 }),
        ]);
        let argv = run(&schema, &[("a", json!("one")), ("b", json!("two")), ("c", json!("three"))]);
        assert_eq!(argv, vec!["one", "three"]);
    }

    #[test]
    fn a_hidden_env_binding_is_not_exported() {
        let schema = make_schema(vec![with_visible_if(
            make_input(
                "token",
                InputType::String { pattern: None, max_len: None },
                Binding::Env { name: "TOKEN".into() },
            ),
            Condition::Truthy { key: "never".into() },
        )]);
        let values: HashMap<String, serde_json::Value> =
            [("token".to_string(), json!("v"))].into_iter().collect();
        let out = build_process_inputs(&schema, &values, &HashMap::new());
        assert!(!out.env.contains_key("TOKEN"), "got {:?}", out.env);
    }

    // --- Secrets ---

    #[test]
    fn a_secret_bound_to_stdin_receives_the_real_value() {
        // validate.rs accepts secret + stdin and its error message recommends it,
        // so stdin must carry the keychain value, not the form sentinel.
        let schema = make_schema(vec![make_input("token", InputType::Secret, Binding::Stdin)]);
        let values: HashMap<String, serde_json::Value> =
            [("token".to_string(), json!("__secret_set__"))].into_iter().collect();
        let secrets: HashMap<String, String> =
            [("token".to_string(), "s3cret".to_string())].into_iter().collect();

        let out = build_process_inputs(&schema, &values, &secrets);
        assert_eq!(out.stdin.as_deref(), Some("s3cret"));
    }

    #[test]
    fn a_secret_bound_to_stdin_without_a_stored_value_sends_nothing() {
        let schema = make_schema(vec![make_input("token", InputType::Secret, Binding::Stdin)]);
        let values: HashMap<String, serde_json::Value> =
            [("token".to_string(), json!("__secret_set__"))].into_iter().collect();

        let out = build_process_inputs(&schema, &values, &HashMap::new());
        assert_eq!(out.stdin, None, "the sentinel must never reach the script");
    }

    #[test]
    fn a_secret_never_appears_in_argv() {
        let schema = make_schema(vec![make_input("token", InputType::Secret, Binding::Env { name: "TOKEN".into() })]);
        let values: HashMap<String, serde_json::Value> =
            [("token".to_string(), json!("__secret_set__"))].into_iter().collect();
        let secrets: HashMap<String, String> =
            [("token".to_string(), "s3cret".to_string())].into_iter().collect();

        let out = build_process_inputs(&schema, &values, &secrets);
        assert_eq!(out.env.get("TOKEN").map(String::as_str), Some("s3cret"));
        assert!(out.argv.is_empty(), "got {:?}", out.argv);
    }
}
