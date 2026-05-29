//! Provider + custom-provider configuration shared with the moxxy CLI.
//!
//! The CLI is authoritative for the schema. The desktop reads + writes
//! the same on-disk files it uses (the project-local `moxxy.config.yaml`
//! also feeds into the CLI's loader when a desk's cwd contains one):
//!
//!   * `~/.moxxy/config.yaml` — user-global config (`provider:` block
//!     using `${vault:NAME}` placeholders).
//!   * `~/.moxxy/vault.json`  — encrypted secrets, owned by the CLI's
//!     vault plugin. We never touch it directly; the desktop pipes
//!     secrets through `moxxy vault set <NAME>` so the CLI's KDF,
//!     keychain, and rotation logic stays in one place.
//!   * `~/.moxxy/providers.json` — custom OpenAI-compatible providers
//!     registered at runtime via the `provider_add` tool.
//!
//! When the user adds their first provider key, the desktop also writes
//! a minimal `provider:` stanza to `~/.moxxy/config.yaml` if one isn't
//! there yet — without that, the runner has no idea the key exists.
//! We avoid pulling in a YAML library: the stanza is fixed shape so
//! a literal-string append is fine, and the upsert is idempotent.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A provider entry as the desktop settings panel sees it. The CLI
/// expects richer config (model lists, auth methods, etc.) but for
/// onboarding we surface just the basics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// Provider name as the CLI knows it: `anthropic`, `openai`,
    /// `openai-codex`, etc.
    pub name: String,
    /// Whether `<NAME>_API_KEY` (or the equivalent vault entry) is
    /// configured in the moxxy config. We never load the actual secret
    /// into the desktop — see [`set_api_key`] for the write path.
    pub configured: bool,
}

/// Three providers known at the moment. The CLI plugin registry
/// determines the real list at runtime; this is the curated subset
/// the onboarding wizard surfaces.
pub fn known_providers() -> Vec<&'static str> {
    vec!["anthropic", "openai", "openai-codex"]
}

/// Inspect `~/.moxxy/config.yaml` for which providers already have a
/// `${vault:…}` reference set. We do a textual scan — cheap, robust
/// against the file being hand-edited, and good enough for the
/// onboarding signal.
pub async fn read_provider_status(path: &Path) -> Vec<ProviderConfig> {
    let body = tokio::fs::read_to_string(path).await.unwrap_or_default();
    known_providers()
        .into_iter()
        .map(|name| {
            let vault_ref = format!("${{vault:{}}}", vault_key_for(name));
            ProviderConfig {
                name: name.to_string(),
                // A provider is "configured" when its `<NAME>_API_KEY`
                // vault reference appears anywhere in the file. Simpler
                // and more accurate than YAML-aware scanning.
                configured: body.contains(&vault_ref),
            }
        })
        .collect()
}

/// Write an API key into the user's moxxy vault. The desktop never
/// stores the secret — we hand it off via the CLI vault command run
/// as a child process, so the key path matches whatever the runner
/// itself will read.
pub fn vault_key_for(provider: &str) -> String {
    format!("{}_API_KEY", provider.to_uppercase().replace('-', "_"))
}

/// Build the `vault set <KEY>` invocation for `provider`. Returns
/// `(program, args)`; the caller spawns it and pipes the secret via
/// stdin. Used by the Tauri command layer.
pub fn vault_set_command(cli_entry: &Path, provider: &str) -> (PathBuf, Vec<String>) {
    let key = vault_key_for(provider);
    (
        PathBuf::from("node"),
        vec![
            cli_entry.to_string_lossy().into_owned(),
            "vault".into(),
            "set".into(),
            key,
        ],
    )
}

/// Ensure `config.yaml` declares `provider: { name, model, config: {
/// apiKey: ${vault:NAME_API_KEY} } }`. If a `provider:` block already
/// exists we leave the file alone — the user may have hand-tuned it
/// and we'd rather lose UX consistency than blow away their model
/// list or fallbacks. Returns `true` if the file was modified.
pub async fn ensure_provider_in_config(
    path: &Path,
    provider: &str,
    model: Option<&str>,
) -> crate::error::AppResult<bool> {
    let existing = tokio::fs::read_to_string(path).await.unwrap_or_default();
    if has_top_level_provider_block(&existing) {
        return Ok(false);
    }
    let key = vault_key_for(provider);
    let model = model.unwrap_or_else(|| default_model_for(provider));
    let stanza = format!(
        "\n# Added by moxxy desktop. Edit freely — the CLI loader\n# picks up any changes on next runner start.\nprovider:\n  name: {provider}\n  model: {model}\n  config:\n    apiKey: ${{vault:{key}}}\n",
    );
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut body = existing;
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str(&stanza);
    // Atomic write so a crash mid-rewrite can't half-truncate the file.
    let tmp = path.with_extension("yaml.tmp");
    tokio::fs::write(&tmp, body).await?;
    tokio::fs::rename(&tmp, path).await?;
    Ok(true)
}

/// True when `body` already has a top-level `provider:` key. Loose
/// scan — we only need to gate the auto-append above.
fn has_top_level_provider_block(body: &str) -> bool {
    body.lines().any(|line| {
        let trimmed = line.trim_end();
        trimmed.starts_with("provider:") && !trimmed.contains(' ')
            || trimmed == "provider:"
            || trimmed.starts_with("provider: ")
    })
}

fn default_model_for(provider: &str) -> &'static str {
    // Sensible defaults that the runner accepts out of the box. Users
    // can swap freely in the YAML afterwards.
    match provider {
        "anthropic" => "claude-opus-4-7",
        "openai" => "gpt-5",
        "openai-codex" => "gpt-5-codex",
        _ => "claude-opus-4-7",
    }
}

// --- Custom providers (`~/.moxxy/providers.json`) ----------------------------

/// A custom OpenAI-compatible provider registered via the runner's
/// `provider_add` tool. Mirrors `packages/plugin-provider-admin`'s
/// stored shape so the desktop can surface them alongside the curated
/// list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomProvider {
    pub name: String,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    #[serde(rename = "defaultModel", default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(rename = "envVar", default, skip_serializing_if = "Option::is_none")]
    pub env_var: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CustomProvidersDoc {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    providers: Vec<CustomProvider>,
}

pub async fn read_custom_providers(path: &Path) -> Vec<CustomProvider> {
    let body = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    serde_json::from_slice::<CustomProvidersDoc>(&body)
        .map(|d| d.providers)
        .unwrap_or_default()
}

#[cfg(test)]
mod ensure_tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn writes_a_stanza_when_config_is_empty() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.yaml");
        let wrote = ensure_provider_in_config(&p, "anthropic", None).await.unwrap();
        assert!(wrote);
        let body = tokio::fs::read_to_string(&p).await.unwrap();
        assert!(body.contains("provider:"));
        assert!(body.contains("name: anthropic"));
        assert!(body.contains("apiKey: ${vault:ANTHROPIC_API_KEY}"));
    }

    #[tokio::test]
    async fn leaves_existing_provider_block_alone() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.yaml");
        let pre = "provider:\n  name: openai\n  model: gpt-5\n";
        tokio::fs::write(&p, pre).await.unwrap();
        let wrote = ensure_provider_in_config(&p, "anthropic", None).await.unwrap();
        assert!(!wrote);
        let body = tokio::fs::read_to_string(&p).await.unwrap();
        assert_eq!(body, pre);
    }

    #[tokio::test]
    async fn appends_to_existing_non_provider_content() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("config.yaml");
        let pre = "mode: tool-use\n";
        tokio::fs::write(&p, pre).await.unwrap();
        ensure_provider_in_config(&p, "openai", Some("gpt-4o")).await.unwrap();
        let body = tokio::fs::read_to_string(&p).await.unwrap();
        assert!(body.starts_with("mode: tool-use"));
        assert!(body.contains("name: openai"));
        assert!(body.contains("model: gpt-4o"));
    }

    #[tokio::test]
    async fn creates_parent_directory() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nested/dir/config.yaml");
        let wrote = ensure_provider_in_config(&p, "anthropic", None).await.unwrap();
        assert!(wrote);
        assert!(p.exists());
    }

    #[tokio::test]
    async fn custom_providers_returns_empty_for_missing_file() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("providers.json");
        let list = read_custom_providers(&p).await;
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn custom_providers_parses_a_real_doc() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("providers.json");
        let body = serde_json::json!({
            "version": 1,
            "providers": [
                {
                    "name": "deepseek",
                    "kind": "openai-compat",
                    "baseURL": "https://api.deepseek.com/v1",
                    "defaultModel": "deepseek-chat",
                    "envVar": "DEEPSEEK_API_KEY"
                }
            ]
        });
        tokio::fs::write(&p, body.to_string()).await.unwrap();
        let list = read_custom_providers(&p).await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "deepseek");
        assert_eq!(list[0].base_url, "https://api.deepseek.com/v1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn vault_key_uppercases_and_normalises() {
        assert_eq!(vault_key_for("anthropic"), "ANTHROPIC_API_KEY");
        assert_eq!(vault_key_for("openai-codex"), "OPENAI_CODEX_API_KEY");
    }

    #[tokio::test]
    async fn read_provider_status_finds_configured_entries() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.yaml");
        let body = r"
providers:
  anthropic:
    apiKey: ${vault:ANTHROPIC_API_KEY}
  openai:
    apiKey: ${vault:OPENAI_API_KEY}
";
        tokio::fs::write(&path, body).await.unwrap();
        let status = read_provider_status(&path).await;
        let anthropic = status.iter().find(|p| p.name == "anthropic").unwrap();
        let openai = status.iter().find(|p| p.name == "openai").unwrap();
        let codex = status.iter().find(|p| p.name == "openai-codex").unwrap();
        assert!(anthropic.configured);
        assert!(openai.configured);
        assert!(!codex.configured);
    }

    #[tokio::test]
    async fn read_provider_status_handles_missing_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nope.yaml");
        let status = read_provider_status(&path).await;
        assert_eq!(status.len(), 3);
        for s in status {
            assert!(!s.configured);
        }
    }

    #[test]
    fn vault_set_command_uses_node_with_cli_entry() {
        let (program, args) = vault_set_command(Path::new("/x/bin.js"), "anthropic");
        assert_eq!(program.to_string_lossy(), "node");
        assert_eq!(args[0], "/x/bin.js");
        assert_eq!(args[1], "vault");
        assert_eq!(args[2], "set");
        assert_eq!(args[3], "ANTHROPIC_API_KEY");
    }
}
