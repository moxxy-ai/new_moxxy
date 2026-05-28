//! Composition root. Holds Arc<dyn _> capability handles for the running app.

use std::sync::Arc;

use moxxy_desktop_core::desks::{json_store::JsonDeskStore, DeskStore};
use moxxy_desktop_core::sidecar::Sidecar;
use moxxy_desktop_core::transport::RunnerTransport;
#[cfg(not(test))]
use moxxy_desktop_core::transport::unix::UnixTransport;

#[derive(Clone)]
pub struct AppState {
    pub desks: Arc<dyn DeskStore>,
    pub sidecar: Arc<dyn Sidecar>,
    pub transport: Arc<dyn RunnerTransport>,
}

impl AppState {
    #[cfg(not(test))]
    pub fn production<R: tauri::Runtime>(
        _app: &tauri::AppHandle<R>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        use moxxy_desktop_core::sidecar::node::{NodeSidecar, NodeSidecarConfig};

        let home = dirs::home_dir().ok_or("home dir unavailable")?;
        let moxxy_dir = home.join(".moxxy");

        let desks = Arc::new(JsonDeskStore::at(moxxy_dir.join("desks.json")));

        let cli_entry = std::env::var("MOXXY_CLI_ENTRY")
            .unwrap_or_else(|_| "/usr/local/bin/moxxy-cli/bin.js".to_string());
        let sidecar = Arc::new(NodeSidecar::new(NodeSidecarConfig {
            cli_entry,
            ..Default::default()
        }));

        let transport: Arc<dyn RunnerTransport> = Arc::new(UnixTransport::default_path()?);

        Ok(Self {
            desks,
            sidecar,
            transport,
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
        sidecar: Arc<dyn Sidecar>,
        transport: Arc<dyn RunnerTransport>,
    ) -> Self {
        Self {
            desks,
            sidecar,
            transport,
        }
    }
}
