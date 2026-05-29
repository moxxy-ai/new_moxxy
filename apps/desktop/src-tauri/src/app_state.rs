//! Composition root. Holds Arc<dyn _> capability handles for the running app.
//!
//! Phase 5 makes the runner side plural: a [`RunnerPool`] manages 1..N
//! sidecars, a [`BridgeRegistry`] tracks one bridge per attached runner,
//! and a [`WindowPinStore`] persists the window→runner mapping so we
//! can restore the layout after a relaunch.
//!
//! The single-window UX still works unchanged: `boot::run` spawns one
//! Primary runner on launch and pins it to the main window.

use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use moxxy_desktop_core::bridge_registry::BridgeRegistry;
use moxxy_desktop_core::desks::{json_store::JsonDeskStore, DeskStore};
use moxxy_desktop_core::pool::{RunnerId, RunnerPool};
use moxxy_desktop_core::schedule::{JsonScheduleStore, ScheduleStore};
use moxxy_desktop_core::windows::{JsonWindowPinStore, WindowId, WindowPinStore};

#[cfg(not(test))]
use moxxy_desktop_core::pool::{NodeRunnerPool, NodeRunnerPoolConfig};

#[derive(Clone)]
pub struct AppState {
    pub desks: Arc<dyn DeskStore>,
    pub pool: Arc<dyn RunnerPool>,
    pub bridges: BridgeRegistry,
    pub window_pins: Arc<dyn WindowPinStore>,
    pub schedules: Arc<dyn ScheduleStore>,
    /// Window-to-runner pinning held in memory so the hot path doesn't
    /// hit disk on every Tauri command. Kept in sync with `window_pins`
    /// (the persisted store) so a relaunch restores the layout.
    pub window_runners: Arc<TokioMutex<std::collections::HashMap<WindowId, RunnerId>>>,
}

impl AppState {
    #[cfg(not(test))]
    pub fn production<R: tauri::Runtime>(
        _app: &tauri::AppHandle<R>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let home = dirs::home_dir().ok_or("home dir unavailable")?;
        let moxxy_dir = home.join(".moxxy");

        let desks = Arc::new(JsonDeskStore::at(moxxy_dir.join("desks.json")));
        let window_pins = Arc::new(JsonWindowPinStore::at(
            moxxy_dir.join("window-pins.json"),
        ));
        let schedules =
            Arc::new(JsonScheduleStore::at(moxxy_dir.join("schedules.json")));

        let cli_entry = resolve_cli_entry();
        let primary_socket = std::env::var("MOXXY_RUNNER_SOCKET")
            .unwrap_or_else(|_| moxxy_dir.join("serve.sock").to_string_lossy().into_owned());

        let pool = Arc::new(NodeRunnerPool::new(NodeRunnerPoolConfig {
            node_bin: "node".into(),
            cli_entry,
            cwd: None,
            primary_socket,
            ephemeral_dir: moxxy_dir.clone(),
        }));

        Ok(Self {
            desks,
            pool,
            bridges: BridgeRegistry::new(),
            window_pins,
            schedules,
            window_runners: Arc::new(TokioMutex::new(std::collections::HashMap::new())),
        })
    }

    #[cfg(test)]
    pub fn production<R: tauri::Runtime>(
        _app: &tauri::AppHandle<R>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Err("AppState::production is not available in test builds".into())
    }

    pub fn for_testing(
        desks: Arc<dyn DeskStore>,
        pool: Arc<dyn RunnerPool>,
        window_pins: Arc<dyn WindowPinStore>,
        schedules: Arc<dyn ScheduleStore>,
    ) -> Self {
        Self {
            desks,
            pool,
            bridges: BridgeRegistry::new(),
            window_pins,
            schedules,
            window_runners: Arc::new(TokioMutex::new(std::collections::HashMap::new())),
        }
    }

    /// Pin a window label to its runner. Updates both the in-memory map
    /// and the persisted store so a relaunch can restore the link.
    pub async fn pin_window(
        &self,
        window: WindowId,
        runner: RunnerId,
    ) -> moxxy_desktop_core::error::AppResult<()> {
        self.window_runners
            .lock()
            .await
            .insert(window.clone(), runner.clone());
        self.window_pins
            .upsert(moxxy_desktop_core::windows::WindowPin {
                window_id: window,
                runner_id: runner,
                desk_id: None,
                session_id: None,
            })
            .await
    }

    /// Look up the runner pinned to `window`, falling back to the
    /// main-window pin if unknown. Returns None when nothing is wired.
    pub async fn runner_for_window(&self, window: &WindowId) -> Option<RunnerId> {
        let map = self.window_runners.lock().await;
        map.get(window)
            .cloned()
            .or_else(|| map.get(&WindowId::main()).cloned())
    }

    /// Kill every runner the pool tracks. Used by the Tauri exit hook
    /// so a Cmd+Q never leaves a stray `node moxxy serve` child behind.
    pub async fn shutdown(&self) {
        let ids: Vec<_> = self.pool.list().into_iter().map(|h| h.id).collect();
        for id in ids {
            if let Err(e) = self.pool.kill(&id).await {
                tracing::warn!(error = %e, "shutdown: failed to kill runner");
            }
        }
    }
}

/// Resolve the moxxy CLI's `bin.js` location. Search order:
///
///   1. `MOXXY_CLI_ENTRY` env var — explicit override, always wins.
///   2. The monorepo dev build at `<repo>/packages/cli/dist/bin.js`,
///      walking up from the binary's cwd. Lets `pnpm tauri:dev` work
///      out of the box.
///   3. The bundled resource path next to the binary (production —
///      not yet wired; will land with Phase 9 packaging).
///   4. A bare `moxxy` on `PATH`, expected to forward to `bin.js`.
///
/// Returns the first candidate that exists, or — if nothing's found —
/// the env value (so the eventual spawn failure message points at the
/// most useful place for the user to look).
#[cfg(not(test))]
fn resolve_cli_entry() -> String {
    use std::path::PathBuf;

    if let Ok(v) = std::env::var("MOXXY_CLI_ENTRY") {
        return v;
    }

    // Walk up looking for `packages/cli/dist/bin.js`.
    if let Ok(cwd) = std::env::current_dir() {
        let mut p: PathBuf = cwd;
        loop {
            let candidate = p.join("packages").join("cli").join("dist").join("bin.js");
            if candidate.is_file() {
                tracing::info!(path = %candidate.display(), "resolved monorepo CLI");
                return candidate.to_string_lossy().into_owned();
            }
            match p.parent() {
                Some(parent) => p = parent.to_path_buf(),
                None => break,
            }
        }
    }

    // Fall back to a bare path — the eventual spawn error will
    // surface as a `runner.error` Tauri event and the user sees a
    // status of `crashed` instead of an opaque silent failure.
    "moxxy".to_string()
}
