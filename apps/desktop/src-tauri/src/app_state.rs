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
use moxxy_desktop_core::windows::{JsonWindowPinStore, WindowId, WindowPinStore};

#[cfg(not(test))]
use moxxy_desktop_core::pool::{NodeRunnerPool, NodeRunnerPoolConfig};

#[derive(Clone)]
pub struct AppState {
    pub desks: Arc<dyn DeskStore>,
    pub pool: Arc<dyn RunnerPool>,
    pub bridges: BridgeRegistry,
    pub window_pins: Arc<dyn WindowPinStore>,
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

        let cli_entry = std::env::var("MOXXY_CLI_ENTRY")
            .unwrap_or_else(|_| "/usr/local/bin/moxxy-cli/bin.js".to_string());
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
    ) -> Self {
        Self {
            desks,
            pool,
            bridges: BridgeRegistry::new(),
            window_pins,
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
}
