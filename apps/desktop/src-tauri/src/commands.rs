//! Tauri commands — the JS-callable surface. Thin wrappers over the
//! capability traits owned by [`AppState`].

use tauri::State;

use crate::app_state::AppState;
use moxxy_desktop_core::desks::{Desk, DeskId};
use moxxy_desktop_core::error::AppResult;
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
