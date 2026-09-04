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
    /// Other PyShell scripts this one expects (by manifest id). See
    /// `ScriptSchema::needs`.
    #[serde(default)]
    needs: Vec<String>,
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
        needs: manifest.needs,
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

    /// Write `content` as a pyshell.yaml into a fresh temp dir, with a dummy
    /// entry file so `entry` resolution has something to point at.
    fn dir_with_manifest(content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pyshell-yaml-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("main.py"), b"print()\n").unwrap();
        std::fs::write(dir.join("pyshell.yaml"), content).unwrap();
        dir
    }

    /// `version` is documented as an arbitrary string, but every manifest in
    /// the community repo writes it as a plain integer (`version: 1`), and a
    /// quoted manifest there would be the exception. This test pins that the
    /// scalar still parses — otherwise every Script Store install would land
    /// with a schema_error and a guessed form.
    #[test]
    fn version_accepts_a_plain_integer_scalar() {
        let dir = dir_with_manifest(
            "schema: 1\nid: x.y\nname: X\nversion: 1\nruntime:\n  entry: main.py\n  python: \">=3\"\n",
        );
        let schema = parse_yaml_manifest(&dir.join("pyshell.yaml"))
            .expect("plain integer version must parse");
        assert_eq!(schema.version.as_deref(), Some("1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_still_accepts_a_quoted_string() {
        let dir = dir_with_manifest(
            "schema: 1\nid: x.y\nname: X\nversion: \"1.2.0\"\nruntime:\n  entry: main.py\n  python: \">=3\"\n",
        );
        let schema = parse_yaml_manifest(&dir.join("pyshell.yaml")).unwrap();
        assert_eq!(schema.version.as_deref(), Some("1.2.0"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A script can declare that it expects other scripts to be installed.
    /// Absent must stay an empty list — every existing manifest has no
    /// `needs`.
    #[test]
    fn needs_parses_and_defaults_to_empty() {
        let dir = dir_with_manifest(
            "schema: 1\nid: x.y\nname: X\nneeds:\n  - com.pyshell.sitecrawler\n  - local.abc\nruntime:\n  entry: main.py\n  python: \">=3\"\n",
        );
        let schema = parse_yaml_manifest(&dir.join("pyshell.yaml")).unwrap();
        assert_eq!(
            schema.needs,
            vec!["com.pyshell.sitecrawler".to_string(), "local.abc".to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);

        let plain = dir_with_manifest(
            "schema: 1\nid: x.y\nname: X\nruntime:\n  entry: main.py\n  python: \">=3\"\n",
        );
        let schema = parse_yaml_manifest(&plain.join("pyshell.yaml")).unwrap();
        assert!(schema.needs.is_empty());
        // …and serializing a schema without needs must not write the field,
        // so a generated manifest stays byte-identical to before.
        let yaml = serde_yaml::to_string(&schema).unwrap();
        assert!(!yaml.contains("needs"));
        let _ = std::fs::remove_dir_all(&plain);
    }

    /// The shipped example pins the whole `needs` path against drift: the
    /// field parses, and it references an id another example really carries.
    #[test]
    fn test_parse_needs_demo_yaml() {
        let yaml_path = std::path::Path::new("../examples/needs-demo/pyshell.yaml");
        if !yaml_path.exists() {
            eprintln!("Skipping test: {} not found", yaml_path.display());
            return;
        }
        let schema = parse_yaml_manifest(yaml_path).expect("YAML should parse");
        assert_eq!(schema.id, "com.pyshell.example.needsdemo");
        assert_eq!(schema.needs, vec!["com.pyshell.example.hello".to_string()]);
        // The dependency id must match a real example, or the demo would
        // warn about a missing dependency forever.
        let hello = parse_yaml_manifest(std::path::Path::new("../examples/hello/pyshell.yaml"))
            .expect("hello example should parse");
        assert_eq!(hello.id, schema.needs[0]);
    }
}
