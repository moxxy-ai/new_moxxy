//! Tauri commands — the JS-callable surface. Thin wrappers over the
//! capability traits owned by [`AppState`].

use serde::Deserialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::app_state::AppState;
use moxxy_desktop_core::desks::{Desk, DeskId};
use moxxy_desktop_core::error::AppResult;
use moxxy_desktop_core::runner_bridge::{RunTurnParams, RunnerBridge};
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
