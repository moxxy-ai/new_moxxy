//! Tauri commands — the JS-callable surface. Thin wrappers over the
//! capability traits owned by [`AppState`].

use serde::Deserialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::app_state::AppState;
use moxxy_desktop_core::desks::{Desk, DeskId};
use moxxy_desktop_core::error::AppResult;
use moxxy_desktop_core::requirements::{InstallHint, RequirementsStatus};
use moxxy_desktop_core::runner_bridge::{RunTurnParams, RunnerBridge};
use moxxy_desktop_core::schedule::{
    is_basic_valid_cron, NewSchedule, ScheduleEntry, ScheduleId, SchedulePatch,
};
use moxxy_desktop_core::sidecar::SidecarStatus;
use moxxy_desktop_core::windows::WindowId;

#[tauri::command]
pub fn sidecar_status(state: State<'_, AppState>) -> SidecarStatus {
    // Coarse, primary-only status. Multi-runner detail is exposed via
    // a dedicated `runners_list` command for the future debug panel.
    let primary = state
        .pool
        .list()
        .into_iter()
        .find(|h| h.kind == moxxy_desktop_core::pool::RunnerKind::Primary);
    primary
        .map(|h| h.sidecar.status())
        .unwrap_or(SidecarStatus::Starting)
}

#[tauri::command]
pub async fn desks_list(state: State<'_, AppState>) -> AppResult<Vec<Desk>> {
    state.desks.list().await
}

#[tauri::command]
pub async fn desks_upsert(state: State<'_, AppState>, desk: Desk) -> AppResult<()> {
    state.desks.upsert(desk).await
}

#[tauri::command]
pub async fn desks_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let id = DeskId::new(id)?;
    state.desks.remove(&id).await
}

#[tauri::command]
pub async fn desks_set_active(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let id = DeskId::new(id)?;
    state.desks.set_active(&id).await
}

#[tauri::command]
pub async fn desks_active(state: State<'_, AppState>) -> AppResult<Option<DeskId>> {
    state.desks.active().await
}

/// Args for `run_turn`. `window` lets a parallel-session window route
/// its turn through its own runner; absent = the main window's runner.
#[derive(Debug, Deserialize)]
pub struct RunTurnArgs {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub window: Option<String>,
}

/// Resolve the bridge for a window label, falling back to the main
/// window's pinned runner.
async fn bridge_for(
    state: &AppState,
    window: Option<String>,
) -> Result<RunnerBridge, String> {
    let window_id = match window {
        Some(raw) => WindowId::new(raw).map_err(|e| e.to_string())?,
        None => WindowId::main(),
    };
    let runner_id = state
        .runner_for_window(&window_id)
        .await
        .ok_or_else(|| "no runner pinned to this window".to_string())?;
    state
        .bridges
        .get(&runner_id)
        .ok_or_else(|| "runner not connected — try again in a moment".to_string())
}

#[tauri::command]
pub async fn run_turn(state: State<'_, AppState>, args: RunTurnArgs) -> Result<String, String> {
    let bridge = bridge_for(&state, args.window).await?;
    let result = bridge
        .run_turn(RunTurnParams {
            prompt: args.prompt,
            model: args.model,
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(result.turn_id)
}

#[tauri::command]
pub async fn abort_turn(
    state: State<'_, AppState>,
    turn_id: String,
    window: Option<String>,
) -> Result<(), String> {
    let bridge = bridge_for(&state, window).await?;
    bridge.abort_turn(turn_id).await.map_err(|e| e.to_string())
}

/// Ask the runner for its current SessionInfo. Returns `null` until
/// the bridge attaches; once it has, the wizard layer reads the
/// `activeProvider` / `activeMode` fields to decide whether to render
/// the inline init UI.
#[tauri::command]
pub async fn runner_info(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    let slot = state.bridges.clone();
    let bridge = {
        let main = moxxy_desktop_core::windows::WindowId::main();
        let runner = match state.runner_for_window(&main).await {
            Some(r) => r,
            None => return Ok(None),
        };
        match slot.get(&runner) {
            Some(b) => b,
            None => return Ok(None),
        }
    };
    let info = bridge.get_info().await.map_err(|e| e.to_string())?;
    Ok(Some(info))
}

/// Switch the runner's active provider. The runner resolves the
/// credential from the vault, so the matching `<NAME>_API_KEY` must
/// already exist there (call `settings_set_api_key` first if not).
#[tauri::command]
pub async fn runner_set_provider(
    state: State<'_, AppState>,
    provider: String,
    config: Option<serde_json::Value>,
) -> Result<(), String> {
    let bridge = bridge_for(&state, None).await?;
    bridge
        .provider_set_active(provider, config)
        .await
        .map_err(|e| e.to_string())
}

/// Switch the runner's active mode.
#[tauri::command]
pub async fn runner_set_mode(
    state: State<'_, AppState>,
    mode: String,
) -> Result<(), String> {
    let bridge = bridge_for(&state, None).await?;
    bridge.mode_set_active(mode).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn runner_ready(
    state: State<'_, AppState>,
    window: Option<String>,
) -> Result<bool, String> {
    let window_id = match window {
        Some(raw) => WindowId::new(raw).map_err(|e| e.to_string())?,
        None => WindowId::main(),
    };
    Ok(match state.runner_for_window(&window_id).await {
        Some(id) => state.bridges.contains(&id),
        None => false,
    })
}

#[tauri::command]
pub async fn transcribe(
    state: State<'_, AppState>,
    audio_b64: String,
    mime_type: Option<String>,
    window: Option<String>,
) -> Result<serde_json::Value, String> {
    let bridge = bridge_for(&state, window).await?;
    bridge
        .transcribe(audio_b64, mime_type)
        .await
        .map_err(|e| e.to_string())
}

/// Spawn an ephemeral runner, connect its bridge, open a new webview
/// window pinned to it, and start fanning that bridge's events into
/// the new window. Returns the new window's label so the JS side can
/// pass it back as `window` on subsequent commands.
///
/// The window URL carries `?window=<label>` so the React app inside it
/// can identify itself in commands without a separate roundtrip.
#[tauri::command]
pub async fn open_session_window<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    use moxxy_desktop_core::pool::RunnerKind;
    use moxxy_desktop_core::runner_bridge::RunnerBridge;

    // 1. Spawn an ephemeral runner.
    let handle = state
        .pool
        .spawn(RunnerKind::Ephemeral)
        .await
        .map_err(|e| format!("spawn ephemeral: {e}"))?;
    let runner_id = handle.id.clone();

    // 2. Wait for the runner socket to accept.
    if let Err(e) = crate::boot::wait_for_runner(&handle).await {
        // Don't leave a half-alive runner behind.
        let _ = state.pool.kill(&runner_id).await;
        return Err(e.to_string());
    }

    // 3. Connect a bridge for it.
    let role = format!("desktop-{}", runner_id.as_str());
    let (bridge, events_rx) = RunnerBridge::connect(handle.transport.clone(), role)
        .await
        .map_err(|e| {
            // Trust but verify: an attach failure shouldn't leak the runner.
            let _pool = state.pool.clone();
            let _rid = runner_id.clone();
            tauri::async_runtime::spawn(async move {
                let _ = _pool.kill(&_rid).await;
            });
            format!("connect bridge: {e}")
        })?;
    state.bridges.insert(runner_id.clone(), bridge);

    // 4. Open the Tauri window. Label namespaced session-<runnerId> so
    // it's stable + traceable in logs.
    let window_label = format!("session-{}", runner_id.as_str());
    let window_id = WindowId::new(window_label.clone()).map_err(|e| e.to_string())?;

    let url = format!("/?window={window_label}");
    let url_parsed: tauri::WebviewUrl = tauri::WebviewUrl::App(url.parse().unwrap_or_default());
    tauri::WebviewWindowBuilder::new(&app, window_label.clone(), url_parsed)
        .title("moxxy")
        .inner_size(1180.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .build()
        .map_err(|e| format!("create window: {e}"))?;

    // 5. Pin the window to the runner and start its event pump.
    state
        .pin_window(window_id.clone(), runner_id.clone())
        .await
        .map_err(|e| e.to_string())?;
    let pump_app = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::boot::pump_events(&pump_app, window_id, events_rx).await;
    });

    Ok(window_label)
}

/// Tear down a parallel-session window: drop the bridge, kill its
/// runner, remove the persisted pin, and close the native window.
/// Refuses to close the main window (use the OS close button for that).
#[tauri::command]
pub async fn close_session_window<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    window: String,
) -> Result<(), String> {
    use tauri::Manager;
    let window_id = WindowId::new(window.clone()).map_err(|e| e.to_string())?;
    if window_id == WindowId::main() {
        return Err("cannot close the main window via this command".into());
    }
    if let Some(runner_id) = state.runner_for_window(&window_id).await {
        // Drop bridge first; killing the sidecar before EOF the reader
        // is sees is fine, but cleaner if our side disconnects first.
        let _ = state.bridges.remove(&runner_id);
        let _ = state.pool.kill(&runner_id).await;
    }
    state
        .window_pins
        .remove(&window_id)
        .await
        .map_err(|e| e.to_string())?;
    state.window_runners.lock().await.remove(&window_id);

    if let Some(w) = app.get_webview_window(window.as_str()) {
        let _ = w.close();
    }
    Ok(())
}

// ---- Schedules --------------------------------------------------------------

#[tauri::command]
pub async fn schedules_list(state: State<'_, AppState>) -> AppResult<Vec<ScheduleEntry>> {
    state.schedules.list().await
}

#[tauri::command]
pub async fn schedules_create(
    state: State<'_, AppState>,
    input: NewSchedule,
) -> Result<ScheduleEntry, String> {
    // Cheap pre-flight so a bad cron is rejected before the disk write.
    if let Some(c) = input.cron.as_deref() {
        if !is_basic_valid_cron(c) {
            return Err(format!("invalid cron expression \"{c}\""));
        }
    }
    state.schedules.create(input).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn schedules_update(
    state: State<'_, AppState>,
    id: String,
    patch: SchedulePatch,
) -> Result<ScheduleEntry, String> {
    let id = ScheduleId::from_raw(id);
    state
        .schedules
        .update(&id, patch)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn schedules_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let id = ScheduleId::from_raw(id);
    state.schedules.delete(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn schedules_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<ScheduleEntry, String> {
    let id = ScheduleId::from_raw(id);
    state
        .schedules
        .set_enabled(&id, enabled)
        .await
        .map_err(|e| e.to_string())
}

/// True if `expr` is at least syntactically a 5-field cron expression.
/// The JS form calls this on debounced input to gate the Submit button.
#[tauri::command]
pub fn schedules_validate_cron(expr: String) -> bool {
    is_basic_valid_cron(&expr)
}

// ---- Settings (providers + skills) -------------------------------------------

#[derive(Debug, serde::Serialize)]
pub struct ProvidersOverview {
    /// Curated providers (anthropic, openai, openai-codex) with a
    /// "configured" flag based on whether `${vault:NAME_API_KEY}` is
    /// referenced in `~/.moxxy/config.yaml`.
    pub known: Vec<moxxy_desktop_core::settings::ProviderConfig>,
    /// Custom OpenAI-compatible providers registered via the runner's
    /// `provider_add` tool. Read from `~/.moxxy/providers.json`.
    pub custom: Vec<moxxy_desktop_core::settings::CustomProvider>,
}

#[tauri::command]
pub async fn settings_providers_list() -> ProvidersOverview {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let known = moxxy_desktop_core::settings::read_provider_status(&home).await;
    let custom = moxxy_desktop_core::settings::read_custom_providers(
        &home.join(".moxxy").join("providers.json"),
    )
    .await;
    ProvidersOverview { known, custom }
}

/// Hand off an API key to the moxxy vault via the CLI's own `vault set`
/// command, piping the secret on stdin. The desktop never persists
/// or logs the value.
#[tauri::command]
pub async fn settings_set_api_key(provider: String, secret: String) -> Result<(), String> {
    use moxxy_desktop_core::requirements::locate_on_path;
    use moxxy_desktop_core::settings::vault_set_command;
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    // Locate the CLI entry the same way boot does.
    let cli_entry: std::path::PathBuf = if let Ok(p) = std::env::var("MOXXY_CLI_ENTRY") {
        p.into()
    } else if let Some(monorepo) = find_monorepo_cli() {
        monorepo
    } else if let Some(bin) = locate_on_path("moxxy") {
        bin
    } else {
        return Err("moxxy CLI not found — run setup first".into());
    };

    let (program, args) = vault_set_command(&cli_entry, &provider);
    let mut child = Command::new(program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn vault: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(secret.as_bytes())
            .await
            .map_err(|e| format!("write secret: {e}"))?;
        // Newline so the CLI's readline-style reader doesn't block.
        let _ = stdin.write_all(b"\n").await;
        drop(stdin);
    }
    let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
    if !status.success() {
        return Err(format!("vault set exited {}", status.code().unwrap_or(-1)));
    }

    // Make sure the runner can actually USE this key — append a
    // minimal `provider:` block to ~/.moxxy/config.yaml when none
    // exists. Without this, vault has the secret but the runner has
    // no idea it's there.
    if let Some(home) = dirs::home_dir() {
        let cfg = home.join(".moxxy").join("config.yaml");
        let _ = moxxy_desktop_core::settings::ensure_provider_in_config(
            &cfg, &provider, None,
        )
        .await;
    }
    Ok(())
}

fn find_monorepo_cli() -> Option<std::path::PathBuf> {
    let mut p = std::env::current_dir().ok()?;
    loop {
        let candidate = p.join("packages").join("cli").join("dist").join("bin.js");
        if candidate.is_file() {
            return Some(candidate);
        }
        p = p.parent()?.to_path_buf();
    }
}

#[tauri::command]
pub async fn settings_skills_list() -> Result<Vec<String>, String> {
    let dir = dirs::home_dir()
        .map(|h| h.join(".moxxy").join("skills"))
        .ok_or_else(|| "no home directory".to_string())?;
    if !dir.exists() {
        // Empty (or never-created) skills dir is a normal state on
        // first launch — return an empty list rather than erroring.
        return Ok(Vec::new());
    }
    let mut entries = tokio::fs::read_dir(&dir).await.map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        if entry.file_name().to_string_lossy().ends_with(".md") {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn settings_skill_read(name: String) -> Result<String, String> {
    let dir = dirs::home_dir()
        .map(|h| h.join(".moxxy").join("skills"))
        .ok_or_else(|| "no home directory".to_string())?;
    // Disallow path traversal.
    if name.contains('/') || name.contains("..") {
        return Err("invalid skill name".into());
    }
    let path = dir.join(&name);
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn settings_skill_write(name: String, body: String) -> Result<(), String> {
    let dir = dirs::home_dir()
        .map(|h| h.join(".moxxy").join("skills"))
        .ok_or_else(|| "no home directory".to_string())?;
    if name.contains('/') || name.contains("..") {
        return Err("invalid skill name".into());
    }
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    tokio::fs::write(&path, body).await.map_err(|e| e.to_string())
}

// ---- Requirements / onboarding ----------------------------------------------

/// Probe the system for Node, the moxxy CLI, and provider config.
/// Returns the full status the wizard renders.
#[tauri::command]
pub async fn requirements_check() -> RequirementsStatus {
    crate::requirements::detect().await
}

/// Run an install hint. For `Command` variants the child is spawned and
/// stdout/stderr stream to the webview as `requirements.install.progress`
/// events; for `OpenUrl` the Tauri opener plugin shells out to the OS.
/// Returns the exit code (0 = success) or an error string.
#[tauri::command]
pub async fn requirements_install<R: Runtime>(
    app: AppHandle<R>,
    hint: InstallHint,
) -> Result<i32, String> {
    match hint {
        InstallHint::Command { program, args, .. } => {
            crate::requirements::run_install_command(&app, program, args).await
        }
        InstallHint::OpenUrl { url, .. } => {
            // Open in the default browser. Tauri-plugin-shell exposes
            // this; we fall back to the OS opener if the plugin call
            // fails for any reason.
            use tauri_plugin_shell::ShellExt;
            app.shell()
                .open(url, None)
                .map_err(|e| e.to_string())?;
            Ok(0)
        }
    }
}

// ---- Dialogs ----------------------------------------------------------------

#[tauri::command]
pub async fn desks_pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::FilePath;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    app.dialog()
        .file()
        .set_title("Choose a folder for this desk")
        .pick_folder(move |selected| {
            let _ = tx.send(selected);
        });
    let selected = rx.await.map_err(|e| format!("picker cancelled: {e}"))?;
    Ok(selected.map(|p| p.to_string()))
}
