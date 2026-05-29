//! Tauri commands — the JS-callable surface. Thin wrappers over the
//! capability traits owned by [`AppState`].

use serde::Deserialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::app_state::AppState;
use moxxy_desktop_core::desks::{Desk, DeskId};
use moxxy_desktop_core::error::AppResult;
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
