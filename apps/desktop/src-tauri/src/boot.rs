//! Startup orchestration. Spawns a background task that:
//!
//!   1. Probes the canonical runner socket — if a live `moxxy serve`
//!      is already listening (e.g. the user has `moxxy tui` open),
//!      we adopt it instead of trying to spawn a duplicate that
//!      would just fail to bind.
//!   2. If no live runner, cleans up any stale socket file then
//!      spawns one via the [`RunnerPool`].
//!   3. Polls the runner's socket until it accepts a connection.
//!   4. Connects a [`RunnerBridge`], stashes it in the
//!      [`BridgeRegistry`], pins the main window to the runner.
//!   5. Pumps the bridge's broadcast events out as Tauri events
//!      addressed to the main window.

use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

use moxxy_desktop_core::pool::{RunnerHandle, RunnerId, RunnerKind};
use moxxy_desktop_core::runner_bridge::{BridgeEvent, RunnerBridge};
use moxxy_desktop_core::transport::{is_runner_up, unix::UnixTransport, RunnerTransport};
use moxxy_desktop_core::windows::WindowId;
use tokio::sync::broadcast;

use crate::app_state::AppState;

pub mod events {
    pub const SIDECAR_STATUS: &str = "sidecar.status";
    pub const RUNNER_READY: &str = "runner.ready";
    pub const RUNNER_EVENT: &str = "runner.event";
    pub const RUNNER_TURN_COMPLETE: &str = "runner.turn.complete";
    pub const RUNNER_INFO_CHANGED: &str = "runner.info.changed";
    pub const RUNNER_LAGGED: &str = "runner.lagged";
    pub const RUNNER_ERROR: &str = "runner.error";
    /// Free-form one-liner the React layer can render in the empty
    /// state so the user sees what boot is actually doing.
    pub const BOOT_STAGE: &str = "boot.stage";
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
    // The canonical primary-runner socket. We try to attach to a
    // running `moxxy serve` here BEFORE spawning anything ourselves.
    let canonical = UnixTransport::default_path()
        .map_err(|e| BootError::Sidecar(format!("default socket path: {e}")))?;
    let canonical_arc: Arc<dyn RunnerTransport> = Arc::new(canonical.clone());

    let (runner_id, transport, adopted) = if is_runner_up(canonical_arc.as_ref()).await {
        // Adoption path — the user has another `moxxy serve` (likely
        // a TUI session) already running on the canonical socket.
        // Spawning a duplicate would fail to bind, so we just attach
        // to the existing one and don't track it in the pool (it owns
        // its own lifecycle).
        let _ = app.emit(events::BOOT_STAGE, "adopting existing runner");
        tracing::info!(socket = %canonical_arc.endpoint(), "adopting existing runner");
        (RunnerId::new(), canonical_arc, true)
    } else {
        // Spawn path — first clean up any stale socket file, since
        // `bind` would otherwise fail.
        unlink_stale_socket(canonical_arc.endpoint()).await;

        let _ = app.emit(events::BOOT_STAGE, "starting moxxy serve");
        let handle = state
            .pool
            .spawn(RunnerKind::Primary)
            .await
            .map_err(|e| BootError::Sidecar(e.to_string()))?;
        let _ = app.emit(events::SIDECAR_STATUS, handle.status());

        let _ = app.emit(events::BOOT_STAGE, "waiting for runner");
        wait_for_runner(&handle).await?;
        (handle.id.clone(), handle.transport.clone(), false)
    };

    // Attach the bridge to whichever runner we ended up with.
    let _ = app.emit(events::BOOT_STAGE, "attaching bridge");
    let (bridge, events_rx) = RunnerBridge::connect(transport, "desktop")
        .await
        .map_err(|e| BootError::Connect(e.to_string()))?;
    state.bridges.insert(runner_id.clone(), bridge);
    state
        .pin_window(WindowId::main(), runner_id.clone())
        .await
        .map_err(|e| BootError::Connect(format!("pin window: {e}")))?;

    let _ = app.emit(
        events::BOOT_STAGE,
        if adopted {
            "attached to running moxxy serve"
        } else {
            "runner ready"
        },
    );
    let _ = app.emit(events::RUNNER_READY, true);

    // 4. Pump events into the main window's event stream.
    pump_events(&app, WindowId::main(), events_rx).await;
    Ok(())
}

/// Remove a unix-socket inode that no process is listening on. Plain
/// `bind` won't recover from a leftover from a crashed server — it'll
/// return EADDRINUSE even though no one's there. Best-effort: a real
/// permissions error still surfaces via the bind attempt that follows.
async fn unlink_stale_socket(endpoint: &str) {
    let path = std::path::Path::new(endpoint);
    if path.exists() {
        match tokio::fs::remove_file(path).await {
            Ok(()) => tracing::info!(socket = %endpoint, "removed stale runner socket"),
            Err(e) => tracing::warn!(error = %e, socket = %endpoint, "failed to remove stale socket"),
        }
    }
}

/// Forward every BridgeEvent on `events_rx` to `window` via `emit_to`.
/// Exits when the bridge closes (the broadcast channel returns Err).
///
/// Pulled out so `open_session_window` can reuse the same routing for
/// ephemeral runners — each parallel-session window has its own pump.
pub async fn pump_events<R: Runtime>(
    app: &AppHandle<R>,
    window: WindowId,
    mut events_rx: broadcast::Receiver<BridgeEvent>,
) {
    let label = window.as_str().to_string();
    while let Ok(event) = events_rx.recv().await {
        match event {
            BridgeEvent::Event { event } => {
                let _ = app.emit_to(label.as_str(), events::RUNNER_EVENT, event);
            }
            BridgeEvent::TurnComplete { turn_id, error } => {
                let _ = app.emit_to(
                    label.as_str(),
                    events::RUNNER_TURN_COMPLETE,
                    serde_json::json!({ "turnId": turn_id, "error": error }),
                );
            }
            BridgeEvent::InfoChanged { info } => {
                let _ = app.emit_to(label.as_str(), events::RUNNER_INFO_CHANGED, info);
            }
            BridgeEvent::Lagged { count } => {
                let _ = app.emit_to(label.as_str(), events::RUNNER_LAGGED, count);
            }
        }
    }
}

/// Wait until `handle`'s socket accepts a connection, polling at
/// [`POLL_INTERVAL`] until [`CONNECT_TIMEOUT`] elapses. Re-usable by
/// the multi-window spawn path.
pub async fn wait_for_runner(handle: &RunnerHandle) -> Result<(), BootError> {
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        if is_runner_up(handle.transport.as_ref()).await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(BootError::Timeout);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BootError {
    #[error("sidecar failed to start: {0}")]
    Sidecar(String),
    #[error("runner did not accept connections within the boot timeout")]
    Timeout,
    #[error("attach failed: {0}")]
    Connect(String),
}
