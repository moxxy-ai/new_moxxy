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

/// Where the moxxy CLI reads its config from, in priority order. Mirrors
/// `packages/config/src/loader.ts` — both the user-level paths AND the
/// project-level paths the loader walks up from cwd.
///
/// `moxxy init` writes `moxxy.config.yaml` to whichever directory was
/// `process.cwd()` when it ran — most commonly the user's home dir, so
/// `~/moxxy.config.yaml` (NOT `~/.moxxy/config.yaml`) is the typical
/// landing spot. We probe every documented extension because the CLI
/// accepts all of them.
pub const CONFIG_EXTENSIONS: &[&str] = &["yaml", "yml", "ts", "js", "mjs", "cjs"];

/// Resolve every config file moxxy would consider, in load order. Used
/// for the requirements check's "did the user run init yet" signal.
pub fn config_search_paths(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // `~/moxxy.config.{ext}` — where moxxy init lands when cwd is $HOME.
    for ext in CONFIG_EXTENSIONS {
        out.push(home.join(format!("moxxy.config.{ext}")));
    }
    // `~/.moxxy/config.{ext}` — the explicit user-global path.
    for ext in CONFIG_EXTENSIONS {
        out.push(home.join(".moxxy").join(format!("config.{ext}")));
    }
    out
}

/// Return the first config file the moxxy loader would find under
/// `home`, if any.
pub async fn locate_user_config(home: &Path) -> Option<PathBuf> {
    for path in config_search_paths(home) {
        if tokio::fs::metadata(&path).await.is_ok() {
            return Some(path);
        }
    }
    None
}

/// Active picks `~/.moxxy/preferences.json` records — the runner reads
/// these on boot to remember the last provider/model the user chose
/// via `/provider` / `/model` slash commands. A populated `provider_name`
/// is concrete proof that the user has at least started using moxxy.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Preferences {
    #[serde(rename = "providerName", default)]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(rename = "loopStrategy", default)]
    pub loop_strategy: Option<String>,
}

pub async fn read_preferences(home: &Path) -> Preferences {
    let path = home.join(".moxxy").join("preferences.json");
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Preferences::default(),
    }
}

/// Names of the vault entries (just the keys — the secrets stay
/// encrypted). Lets us check whether `<PROVIDER>_API_KEY` exists without
/// shelling out to the CLI or doing any KDF work.
pub async fn vault_entry_names(home: &Path) -> Vec<String> {
    let path = home.join(".moxxy").join("vault.json");
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Vec::new();
    };
    doc["entries"]
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

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

/// Per-provider "configured" status. A provider is considered
/// configured when EITHER:
///   - any of the moxxy config files (user-global or home-root) has a
///     `${vault:NAME_API_KEY}` reference for it, OR
///   - the vault has an entry under that key (the runner picks the
///     value up via the same env-var contract `provider_add` uses).
/// The second branch is what catches users who pasted a key via the
/// TUI but never wrote a YAML stanza.
pub async fn read_provider_status(home: &Path) -> Vec<ProviderConfig> {
    let mut bodies: Vec<String> = Vec::new();
    for path in config_search_paths(home) {
        if let Ok(body) = tokio::fs::read_to_string(&path).await {
            bodies.push(body);
        }
    }
    let vault_keys = vault_entry_names(home).await;
    known_providers()
        .into_iter()
        .map(|name| {
            let vault_key = vault_key_for(name);
            let vault_ref = format!("${{vault:{vault_key}}}");
            let in_config = bodies.iter().any(|b| b.contains(&vault_ref));
            let in_vault = vault_keys.iter().any(|k| k == &vault_key);
            ProviderConfig {
                name: name.to_string(),
                configured: in_config || in_vault,
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
    async fn read_provider_status_finds_yaml_at_home_root() {
        // `moxxy init` writes to <cwd>/moxxy.config.yaml — when cwd is
        // $HOME, that lands at ~/moxxy.config.yaml. The desktop must
        // see that file just like the runner does.
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("moxxy.config.yaml");
        let body = r"
provider:
  name: anthropic
  config:
    apiKey: ${vault:ANTHROPIC_API_KEY}
";
        tokio::fs::write(&path, body).await.unwrap();
        let status = read_provider_status(tmp.path()).await;
        let anthropic = status.iter().find(|p| p.name == "anthropic").unwrap();
        let codex = status.iter().find(|p| p.name == "openai-codex").unwrap();
        assert!(anthropic.configured);
        assert!(!codex.configured);
    }

    #[tokio::test]
    async fn read_provider_status_finds_yaml_under_moxxy_dir() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".moxxy");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let body = "provider:\n  name: openai\n  config:\n    apiKey: ${vault:OPENAI_API_KEY}\n";
        tokio::fs::write(dir.join("config.yaml"), body).await.unwrap();
        let status = read_provider_status(tmp.path()).await;
        let openai = status.iter().find(|p| p.name == "openai").unwrap();
        assert!(openai.configured);
    }

    #[tokio::test]
    async fn read_provider_status_uses_vault_entry_as_proof() {
        // A user who pasted a key via the TUI but never wrote a YAML
        // stanza still has the runner find it. The desktop should
        // mirror that — pure vault entry counts as "configured".
        let tmp = TempDir::new().unwrap();
        let moxxy_dir = tmp.path().join(".moxxy");
        tokio::fs::create_dir_all(&moxxy_dir).await.unwrap();
        let vault = serde_json::json!({
            "version": 1,
            "entries": {
                "ANTHROPIC_API_KEY": { "iv": "x", "ciphertext": "y", "authTag": "z" }
            }
        });
        tokio::fs::write(moxxy_dir.join("vault.json"), vault.to_string())
            .await
            .unwrap();
        let status = read_provider_status(tmp.path()).await;
        let anthropic = status.iter().find(|p| p.name == "anthropic").unwrap();
        assert!(anthropic.configured);
    }

    #[tokio::test]
    async fn read_provider_status_handles_a_blank_home() {
        let tmp = TempDir::new().unwrap();
        let status = read_provider_status(tmp.path()).await;
        assert_eq!(status.len(), 3);
        for s in status {
            assert!(!s.configured);
        }
    }

    #[tokio::test]
    async fn locate_user_config_finds_home_root_yaml() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("moxxy.config.yaml");
        tokio::fs::write(&path, "provider: foo\n").await.unwrap();
        let found = locate_user_config(tmp.path()).await.unwrap();
        assert_eq!(found, path);
    }

    #[tokio::test]
    async fn locate_user_config_walks_all_extensions() {
        for ext in ["yml", "ts", "mjs"] {
            let tmp = TempDir::new().unwrap();
            let path = tmp.path().join(format!("moxxy.config.{ext}"));
            tokio::fs::write(&path, "x").await.unwrap();
            let found = locate_user_config(tmp.path()).await.unwrap();
            assert_eq!(found, path);
        }
    }

    #[tokio::test]
    async fn read_preferences_returns_default_when_missing() {
        let tmp = TempDir::new().unwrap();
        let prefs = read_preferences(tmp.path()).await;
        assert!(prefs.provider_name.is_none());
    }

    #[tokio::test]
    async fn read_preferences_parses_the_runner_shape() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".moxxy");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let body = serde_json::json!({
            "providerName": "openai-codex",
            "model": "gpt-5.5",
            "mode": "tool-use",
            "loopStrategy": "tool-use",
        });
        tokio::fs::write(dir.join("preferences.json"), body.to_string())
            .await
            .unwrap();
        let prefs = read_preferences(tmp.path()).await;
        assert_eq!(prefs.provider_name.as_deref(), Some("openai-codex"));
        assert_eq!(prefs.model.as_deref(), Some("gpt-5.5"));
    }

    #[tokio::test]
    async fn vault_entry_names_lists_keys_without_decryption() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join(".moxxy");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let body = serde_json::json!({
            "entries": {
                "ANTHROPIC_API_KEY": {},
                "OPENAI_API_KEY": {}
            }
        });
        tokio::fs::write(dir.join("vault.json"), body.to_string())
            .await
            .unwrap();
        let mut names = vault_entry_names(tmp.path()).await;
        names.sort();
        assert_eq!(names, vec!["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
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
