//! Tauri commands — the JS-callable surface. Thin wrappers over the
//! capability traits owned by [`AppState`].

use serde::Deserialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::app_state::AppState;
use moxxy_desktop_core::desks::{Desk, DeskId};
use moxxy_desktop_core::error::AppResult;
use moxxy_desktop_core::runner_bridge::RunTurnParams;
use moxxy_desktop_core::sidecar::SidecarStatus;

#[tauri::command]
pub fn sidecar_status(state: State<'_, AppState>) -> SidecarStatus {
    state.sidecar.status()
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

/// Args for `run_turn`. Kept distinct from the core `RunTurnParams` so we
/// can add IPC-only fields (e.g. window id, attachments by path) without
/// touching the wire-facing struct.
#[derive(Debug, Deserialize)]
pub struct RunTurnArgs {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
}

/// Take an owned Arc<Mutex<_>> handle before awaiting on the lock —
/// otherwise the lock future borrows from `State<'_, _>`, which isn't
/// `'static` and Tauri command futures must be.
async fn clone_bridge(
    state: &AppState,
) -> Result<moxxy_desktop_core::runner_bridge::RunnerBridge, String> {
    let slot = state.bridge.clone();
    let guard = slot.lock().await;
    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "runner not connected — try again in a moment".to_string())
}

/// Issue a turn to the connected primary runner. Returns the turn id;
/// events stream out as `runner.event` Tauri events from the fan-out
/// task wired up in `lib.rs` at boot.
#[tauri::command]
pub async fn run_turn(state: State<'_, AppState>, args: RunTurnArgs) -> Result<String, String> {
    let bridge = clone_bridge(&state).await?;
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

/// Abort an in-flight turn by id.
#[tauri::command]
pub async fn abort_turn(state: State<'_, AppState>, turn_id: String) -> Result<(), String> {
    let bridge = clone_bridge(&state).await?;
    bridge.abort_turn(turn_id).await.map_err(|e| e.to_string())
}

/// True once the runner is attached and `run_turn` is callable.
/// Tauri requires async commands with reference inputs to return a
/// `Result`; the `Err` arm is unused here in practice.
#[tauri::command]
pub async fn runner_ready(state: State<'_, AppState>) -> Result<bool, String> {
    let slot = state.bridge.clone();
    let guard = slot.lock().await;
    Ok(guard.is_some())
}

/// Forward an already-base64-encoded audio blob to the runner's
/// transcribe RPC. The JS side captures via MediaRecorder, encodes once,
/// passes the string here; we forward without re-encoding so the audio
/// crosses both IPC hops as the same compact format.
#[tauri::command]
pub async fn transcribe(
    state: State<'_, AppState>,
    audio_b64: String,
    mime_type: Option<String>,
) -> Result<serde_json::Value, String> {
    let bridge = clone_bridge(&state).await?;
    bridge
        .transcribe(audio_b64, mime_type)
        .await
        .map_err(|e| e.to_string())
}

/// Open the native folder picker. Returns the absolute path the user
/// chose, or `None` if they cancelled. Used by the "new desk" flow.
/// The picker runs as a callback (Tauri's dialog API isn't `Future`-
/// shaped) so we bridge through a oneshot.
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
