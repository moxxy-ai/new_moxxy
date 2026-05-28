//! Startup orchestration. Spawns a background task that:
//!
//!   1. Spawns the primary runner via the [`RunnerPool`].
//!   2. Polls the runner's socket until it accepts a connection — or
//!      gives up after a timeout.
//!   3. Connects a [`RunnerBridge`], stashes it in the
//!      [`BridgeRegistry`], pins the main window to the runner.
//!   4. Pumps the bridge's broadcast events out as Tauri events
//!      addressed to the main window.

use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

use moxxy_desktop_core::pool::RunnerKind;
use moxxy_desktop_core::runner_bridge::{BridgeEvent, RunnerBridge};
use moxxy_desktop_core::transport::is_runner_up;
use moxxy_desktop_core::windows::WindowId;

use crate::app_state::AppState;

pub mod events {
    pub const SIDECAR_STATUS: &str = "sidecar.status";
    pub const RUNNER_READY: &str = "runner.ready";
    pub const RUNNER_EVENT: &str = "runner.event";
    pub const RUNNER_TURN_COMPLETE: &str = "runner.turn.complete";
    pub const RUNNER_INFO_CHANGED: &str = "runner.info.changed";
    pub const RUNNER_LAGGED: &str = "runner.lagged";
    pub const RUNNER_ERROR: &str = "runner.error";
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(120);

pub fn spawn<R: Runtime>(app: AppHandle<R>, state: AppState) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app.clone(), state).await {
            tracing::warn!(error = %e, "boot task failed");
            let _ = app.emit(events::RUNNER_ERROR, e.to_string());
        }
    });
}

async fn run<R: Runtime>(app: AppHandle<R>, state: AppState) -> Result<(), BootError> {
    // 1. Spawn the primary runner.
    let handle = state
        .pool
        .spawn(RunnerKind::Primary)
        .await
        .map_err(|e| BootError::Sidecar(e.to_string()))?;
    let _ = app.emit(events::SIDECAR_STATUS, handle.status());

    // 2. Wait until the socket accepts connections.
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        if is_runner_up(handle.transport.as_ref()).await {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(BootError::Timeout);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }

    // 3. Connect and stash the bridge; pin the main window.
    let (bridge, mut events_rx) = RunnerBridge::connect(handle.transport.clone(), "desktop")
        .await
        .map_err(|e| BootError::Connect(e.to_string()))?;
    state.bridges.insert(handle.id.clone(), bridge);
    state
        .pin_window(WindowId::main(), handle.id.clone())
        .await
        .map_err(|e| BootError::Connect(format!("pin window: {e}")))?;
    let _ = app.emit(events::RUNNER_READY, true);

    // 4. Pump events into the main window's event stream.
    let main = WindowId::main();
    while let Ok(event) = events_rx.recv().await {
        let label = main.as_str();
        match event {
            BridgeEvent::Event { event } => {
                let _ = app.emit_to(label, events::RUNNER_EVENT, event);
            }
            BridgeEvent::TurnComplete { turn_id, error } => {
                let _ = app.emit_to(
                    label,
                    events::RUNNER_TURN_COMPLETE,
                    serde_json::json!({ "turnId": turn_id, "error": error }),
                );
            }
            BridgeEvent::InfoChanged { info } => {
                let _ = app.emit_to(label, events::RUNNER_INFO_CHANGED, info);
            }
            BridgeEvent::Lagged { count } => {
                let _ = app.emit_to(label, events::RUNNER_LAGGED, count);
            }
        }
    }

    Ok(())
}

#[derive(Debug, thiserror::Error)]
enum BootError {
    #[error("sidecar failed to start: {0}")]
    Sidecar(String),
    #[error("runner did not accept connections within the boot timeout")]
    Timeout,
    #[error("attach failed: {0}")]
    Connect(String),
}
