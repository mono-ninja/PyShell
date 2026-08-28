use std::path::Path;

use serde::Deserialize;

use super::model::{InputSpec, Runtime, ScriptSchema, SchemaSource};
use crate::error::{AppError, Result};

/// A pyshell.yaml file wraps the schema with the `entry` path resolved
/// relative to the manifest's directory.
#[derive(Deserialize)]
struct YamlManifest {
    schema: u8,
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    category: Option<String>,
    runtime: RuntimeYaml,
    #[serde(default)]
    inputs: Vec<InputSpec>,
    #[serde(default)]
    outputs: super::model::Outputs,
}

#[derive(Deserialize)]
struct RuntimeYaml {
    entry: String,
    python: String,
    #[serde(default)]
    requirements: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
}

pub fn parse_yaml_manifest(manifest_path: &Path) -> Result<ScriptSchema> {
    let content = std::fs::read_to_string(manifest_path)?;
    let manifest: YamlManifest = serde_yaml::from_str(&content)
        .map_err(|e| AppError::Manifest(format!("yaml parse error: {}", e)))?;

    let dir = manifest_path.parent().unwrap_or(Path::new("."));

    let entry = dir.join(&manifest.runtime.entry);
    let requirements = manifest.runtime.requirements.map(|r| dir.join(r));

    let id = manifest.id.unwrap_or_else(|| {
        let canonical = entry.canonicalize().unwrap_or_else(|_| entry.clone());
        let hash = sha256_hex(&canonical.to_string_lossy());
        format!("local.{}", &hash[..16])
    });

    // Validate inputs (pass raw YAML for line-number reporting)
    super::validate::validate(&manifest.inputs, Some(&content))?;

    Ok(ScriptSchema {
        schema: manifest.schema,
        id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        icon: manifest.icon,
        category: manifest.category,
        runtime: Runtime {
            entry,
            python: manifest.runtime.python,
            requirements,
            timeout: manifest.runtime.timeout,
        },
        inputs: manifest.inputs,
        outputs: manifest.outputs,
        source: SchemaSource::Yaml,
    })
}

pub fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::model::{Binding, ArgStyle};

    #[test]
    fn test_parse_ip_domains_yaml() {
        let yaml_path = std::path::Path::new("../examples/ip-domains/pyshell.yaml");
        if !yaml_path.exists() {
            eprintln!("Skipping test: {} not found", yaml_path.display());
            return;
        }
        let schema = parse_yaml_manifest(yaml_path).expect("YAML should parse");
        assert_eq!(schema.name, "IP → Domains Finder");

        // Check the sources input has a Joined binding
        let sources = schema.inputs.iter().find(|i| i.key == "sources").unwrap();
        match &sources.binding {
            Binding::Arg { flag, style } => {
                assert_eq!(flag, "--sources");
                match style {
                    ArgStyle::Joined { sep } => assert_eq!(sep, " "),
                    other => panic!("expected Joined, got {:?}", other),
                }
            }
            other => panic!("expected Arg, got {:?}", other),
        }

        // Check the shodan_key has an Env binding
        let shodan = schema.inputs.iter().find(|i| i.key == "shodan_key").unwrap();
        match &shodan.binding {
            Binding::Env { name } => assert_eq!(name, "SHODAN_API_KEY"),
            other => panic!("expected Env, got {:?}", other),
        }

        // Check the ip has a Positional binding
        let ip = schema.inputs.iter().find(|i| i.key == "ip").unwrap();
        match &ip.binding {
            Binding::Positional { index } => assert_eq!(*index, 0),
            other => panic!("expected Positional, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_ninjascan_yaml() {
        let yaml_path = std::path::Path::new("../examples/ninjascan/pyshell.yaml");
        if !yaml_path.exists() {
            eprintln!("Skipping test: {} not found", yaml_path.display());
            return;
        }
        let schema = parse_yaml_manifest(yaml_path).expect("YAML should parse");
        assert_eq!(schema.name, "NinjaScan");
        assert_eq!(schema.id, "com.pyshell.example.ninjascan");

        // url — positional
        let url = schema.inputs.iter().find(|i| i.key == "url").unwrap();
        match &url.binding {
            Binding::Positional { index } => assert_eq!(*index, 0),
            other => panic!("expected Positional, got {:?}", other),
        }

        // auth_pass — secret → env
        let auth_pass = schema.inputs.iter().find(|i| i.key == "auth_pass").unwrap();
        match &auth_pass.binding {
            Binding::Env { name } => assert_eq!(name, "NINJASCAN_AUTH_PASS"),
            other => panic!("expected Env, got {:?}", other),
        }

        // skip_plugins — bool flag
        let skip_plugins = schema.inputs.iter().find(|i| i.key == "skip_plugins").unwrap();
        match &skip_plugins.binding {
            Binding::Arg { flag, style } => {
                assert_eq!(flag, "--skip-plugins");
                assert!(matches!(style, ArgStyle::Flag));
            }
            other => panic!("expected Arg/Flag, got {:?}", other),
        }

        // verbose — short flag
        let verbose = schema.inputs.iter().find(|i| i.key == "verbose").unwrap();
        match &verbose.binding {
            Binding::Arg { flag, style } => {
                assert_eq!(flag, "-v");
                assert!(matches!(style, ArgStyle::Flag));
            }
            other => panic!("expected Arg/Flag, got {:?}", other),
        }

        // timeout — int with space style
        let timeout = schema.inputs.iter().find(|i| i.key == "timeout").unwrap();
        match &timeout.binding {
            Binding::Arg { flag, style } => {
                assert_eq!(flag, "--timeout");
                assert!(matches!(style, ArgStyle::Space));
            }
            other => panic!("expected Arg/Space, got {:?}", other),
        }

        // Check group assignments
        assert_eq!(url.group.as_deref(), Some("Target"));
        assert_eq!(skip_plugins.group.as_deref(), Some("Checks"));

        // Check artifacts
        assert!(schema.outputs.artifacts.contains(&"*.html".to_string()));
        assert!(schema.outputs.artifacts.contains(&"*.json".to_string()));
        assert!(schema.outputs.artifacts.contains(&"*.sarif".to_string()));
    }
}
