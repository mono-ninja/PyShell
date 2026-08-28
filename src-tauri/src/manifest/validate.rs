use super::model::{Binding, InputSpec, InputType};
use crate::error::{AppError, Result};

pub fn validate(inputs: &[InputSpec], source: Option<&str>) -> Result<()> {
    let mut keys = std::collections::HashSet::new();
    let mut stdin_count = 0;
    let mut positional_indices = std::collections::HashSet::new();

    for input in inputs {
        // Duplicate keys
        if !keys.insert(&input.key) {
            let loc = find_key_location(source, &input.key);
            return Err(AppError::Manifest(format!(
                "duplicate input key: '{}'{}",
                input.key,
                loc.unwrap_or_default()
            )));
        }

        // At most one Stdin binding
        if matches!(input.binding, Binding::Stdin) {
            stdin_count += 1;
            if stdin_count > 1 {
                let loc = find_key_location(source, &input.key);
                return Err(AppError::Manifest(format!(
                    "at most one input can use binding: stdin (key: '{}'{})",
                    input.key,
                    loc.unwrap_or_default()
                )));
            }
        }

        // Positional indices must be contiguous (no gaps)
        if let Binding::Positional { index } = &input.binding {
            if !positional_indices.insert(*index) {
                let loc = find_key_location(source, &input.key);
                return Err(AppError::Manifest(format!(
                    "duplicate positional index: {} (key: '{}'{})",
                    index,
                    input.key,
                    loc.unwrap_or_default()
                )));
            }
        }

        // Secrets must NOT use Binding::Arg — `ps aux` exposes argv (Plan.md §0)
        if matches!(input.r#type, InputType::Secret) {
            if matches!(input.binding, Binding::Arg { .. } | Binding::TempFile { .. } | Binding::Positional { .. }) {
                let loc = find_key_location(source, &input.key);
                return Err(AppError::Manifest(format!(
                    "secret input '{}' must use binding: env or stdin (never arg/temp_file/positional){}",
                    input.key,
                    loc.unwrap_or_default()
                )));
            }
        }

        // visible_if must reference an existing key
        if let Some(cond) = &input.visible_if {
            let ref_key = match cond {
                super::model::Condition::Eq { key, .. }
                | super::model::Condition::Ne { key, .. }
                | super::model::Condition::Truthy { key } => key,
            };
            if !inputs.iter().any(|i| &i.key == ref_key) {
                let loc = find_key_location(source, &input.key);
                return Err(AppError::Manifest(format!(
                    "visible_if on key '{}' references unknown key '{}'{}",
                    input.key,
                    ref_key,
                    loc.unwrap_or_default()
                )));
            }
        }

        // Choice/MultiChoice must have at least one option
        match &input.r#type {
            InputType::Choice { options } | InputType::MultiChoice { options } => {
                if options.is_empty() {
                    let loc = find_key_location(source, &input.key);
                    return Err(AppError::Manifest(format!(
                        "choice input '{}' has no options{}",
                        input.key,
                        loc.unwrap_or_default()
                    )));
                }
            }
            _ => {}
        }
    }

    // Positional indices must be contiguous 0..n
    if !positional_indices.is_empty() {
        let max = *positional_indices.iter().max().unwrap();
        for i in 0..=max {
            if !positional_indices.contains(&i) {
                return Err(AppError::Manifest(format!(
                    "positional indices have a gap at {}",
                    i
                )));
            }
        }
    }

    Ok(())
}

/// Find the line number of a key in the raw YAML source text.
/// Returns a formatted string like " at line 5" or None if source is unavailable.
fn find_key_location(source: Option<&str>, key: &str) -> Option<String> {
    let source = source?;
    let pattern = format!("key: {}", key);
    let pattern_quoted = format!("key: \"{}\"", key);
    let pattern_sq = format!("key: '{}'", key);

    for (i, line) in source.lines().enumerate() {
        // `inputs` is a YAML list, so the first field of an item carries a "- "
        // prefix (`  - key: url`) — strip it or nothing ever matches.
        let trimmed = line.trim_start();
        let trimmed = trimmed.strip_prefix("- ").unwrap_or(trimmed).trim_start();
        if trimmed.starts_with(&pattern)
            || trimmed.starts_with(&pattern_quoted)
            || trimmed.starts_with(&pattern_sq)
        {
            return Some(format!(" at line {}", i + 1));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::model::{ArgStyle, ChoiceOption, Condition};

    fn input(key: &str, r#type: InputType, binding: Binding) -> InputSpec {
        InputSpec {
            key: key.to_string(),
            r#type,
            label: key.to_string(),
            help: None,
            required: false,
            default: None,
            group: None,
            visible_if: None,
            binding,
        }
    }

    fn string() -> InputType {
        InputType::String { pattern: None, max_len: None }
    }

    fn arg(flag: &str) -> Binding {
        Binding::Arg { flag: flag.to_string(), style: ArgStyle::Space }
    }

    fn env(name: &str) -> Binding {
        Binding::Env { name: name.to_string() }
    }

    fn error_of(inputs: Vec<InputSpec>) -> String {
        match validate(&inputs, None) {
            Ok(()) => panic!("expected validation to fail, but it passed"),
            Err(e) => e.to_string(),
        }
    }

    // --- Secrets must never be reachable from argv (`ps aux` exposes it) ---

    #[test]
    fn secret_with_arg_binding_is_rejected() {
        let err = error_of(vec![input("token", InputType::Secret, arg("--token"))]);
        assert!(err.contains("token"), "{}", err);
        assert!(err.contains("never arg/temp_file/positional"), "{}", err);
    }

    #[test]
    fn secret_with_temp_file_binding_is_rejected() {
        // The path lands in argv, and the plaintext lands in a world-readable tmp file.
        let err = error_of(vec![input(
            "token",
            InputType::Secret,
            Binding::TempFile { flag: "--token-file".to_string() },
        )]);
        assert!(err.contains("never arg/temp_file/positional"), "{}", err);
    }

    #[test]
    fn secret_with_positional_binding_is_rejected() {
        let err = error_of(vec![input(
            "token",
            InputType::Secret,
            Binding::Positional { index: 0 },
        )]);
        assert!(err.contains("never arg/temp_file/positional"), "{}", err);
    }

    #[test]
    fn secret_with_arg_binding_is_rejected_for_every_style() {
        for style in [
            ArgStyle::Space,
            ArgStyle::Equals,
            ArgStyle::Flag,
            ArgStyle::Repeat,
            ArgStyle::Joined { sep: ",".to_string() },
        ] {
            let binding = Binding::Arg { flag: "--token".to_string(), style: style.clone() };
            assert!(
                validate(&[input("token", InputType::Secret, binding)], None).is_err(),
                "secret + arg/{:?} must be rejected",
                style
            );
        }
    }

    #[test]
    fn secret_with_env_binding_is_accepted() {
        assert!(validate(&[input("token", InputType::Secret, env("TOKEN"))], None).is_ok());
    }

    #[test]
    fn secret_with_stdin_binding_is_accepted() {
        // Accepted by validation, and the error message above recommends it.
        assert!(validate(&[input("token", InputType::Secret, Binding::Stdin)], None).is_ok());
    }

    #[test]
    fn a_non_secret_may_use_any_binding() {
        assert!(validate(&[input("url", string(), arg("--url"))], None).is_ok());
        assert!(validate(
            &[input("data", InputType::Multiline, Binding::TempFile { flag: "-f".to_string() })],
            None
        )
        .is_ok());
        assert!(validate(&[input("src", string(), Binding::Positional { index: 0 })], None).is_ok());
    }

    // --- Structural rules ---

    #[test]
    fn duplicate_keys_are_rejected() {
        let err = error_of(vec![
            input("url", string(), arg("--url")),
            input("url", string(), arg("--other")),
        ]);
        assert!(err.contains("duplicate input key"), "{}", err);
    }

    #[test]
    fn two_stdin_bindings_are_rejected() {
        let err = error_of(vec![
            input("a", string(), Binding::Stdin),
            input("b", string(), Binding::Stdin),
        ]);
        assert!(err.contains("at most one input can use binding: stdin"), "{}", err);
    }

    #[test]
    fn one_stdin_binding_is_fine() {
        assert!(validate(
            &[input("a", string(), Binding::Stdin), input("b", string(), arg("--b"))],
            None
        )
        .is_ok());
    }

    #[test]
    fn duplicate_positional_indices_are_rejected() {
        let err = error_of(vec![
            input("a", string(), Binding::Positional { index: 0 }),
            input("b", string(), Binding::Positional { index: 0 }),
        ]);
        assert!(err.contains("duplicate positional index"), "{}", err);
    }

    #[test]
    fn a_gap_in_positional_indices_is_rejected() {
        let err = error_of(vec![
            input("a", string(), Binding::Positional { index: 0 }),
            input("c", string(), Binding::Positional { index: 2 }),
        ]);
        assert!(err.contains("gap at 1"), "{}", err);
    }

    #[test]
    fn contiguous_positionals_are_accepted_in_any_order() {
        assert!(validate(
            &[
                input("b", string(), Binding::Positional { index: 1 }),
                input("a", string(), Binding::Positional { index: 0 }),
                input("c", string(), Binding::Positional { index: 2 }),
            ],
            None
        )
        .is_ok());
    }

    #[test]
    fn positionals_must_start_at_zero() {
        let err = error_of(vec![input("a", string(), Binding::Positional { index: 1 })]);
        assert!(err.contains("gap at 0"), "{}", err);
    }

    #[test]
    fn visible_if_referencing_an_unknown_key_is_rejected() {
        let mut dependent = input("advanced", string(), arg("--advanced"));
        dependent.visible_if = Some(Condition::Truthy { key: "nope".to_string() });
        let err = error_of(vec![dependent]);
        assert!(err.contains("references unknown key 'nope'"), "{}", err);
    }

    #[test]
    fn visible_if_referencing_an_existing_key_is_accepted() {
        let mut dependent = input("advanced", string(), arg("--advanced"));
        dependent.visible_if = Some(Condition::Eq {
            key: "mode".to_string(),
            value: serde_json::json!("advanced"),
        });
        assert!(validate(&[input("mode", string(), arg("--mode")), dependent], None).is_ok());
    }

    #[test]
    fn a_choice_without_options_is_rejected() {
        let err = error_of(vec![input(
            "mode",
            InputType::Choice { options: vec![] },
            arg("--mode"),
        )]);
        assert!(err.contains("has no options"), "{}", err);
    }

    #[test]
    fn a_multi_choice_without_options_is_rejected() {
        let err = error_of(vec![input(
            "tags",
            InputType::MultiChoice { options: vec![] },
            arg("--tag"),
        )]);
        assert!(err.contains("has no options"), "{}", err);
    }

    #[test]
    fn a_choice_with_options_is_accepted() {
        let options = vec![ChoiceOption { value: "a".to_string(), label: None }];
        assert!(validate(
            &[input("mode", InputType::Choice { options }, arg("--mode"))],
            None
        )
        .is_ok());
    }

    #[test]
    fn an_empty_manifest_is_valid() {
        assert!(validate(&[], None).is_ok());
    }

    #[test]
    fn the_error_points_at_the_offending_line_when_source_is_available() {
        // Real manifests write inputs as a YAML list, so the key line looks like
        // `  - key: url` rather than `  key: url`.
        let source = "inputs:\n  - key: url\n    type: string\n  - key: url\n    type: string\n";
        let inputs = vec![
            input("url", string(), arg("--url")),
            input("url", string(), arg("--url2")),
        ];
        let err = validate(&inputs, Some(source)).unwrap_err().to_string();
        assert!(err.contains("at line 2"), "{}", err);
    }

    #[test]
    fn the_line_hint_also_works_when_key_is_not_the_first_field() {
        let source = "inputs:\n  - type: string\n    key: url\n";
        let inputs = vec![
            input("url", string(), arg("--url")),
            input("url", string(), arg("--url2")),
        ];
        let err = validate(&inputs, Some(source)).unwrap_err().to_string();
        assert!(err.contains("at line 3"), "{}", err);
    }

    #[test]
    fn a_quoted_key_is_located_too() {
        let source = "inputs:\n  - key: \"url\"\n    type: string\n";
        let inputs = vec![
            input("url", string(), arg("--url")),
            input("url", string(), arg("--url2")),
        ];
        let err = validate(&inputs, Some(source)).unwrap_err().to_string();
        assert!(err.contains("at line 2"), "{}", err);
    }
}
