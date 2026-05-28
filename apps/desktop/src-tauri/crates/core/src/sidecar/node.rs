//! Production sidecar — spawns `node` running the moxxy CLI's `serve` command.

use async_trait::async_trait;
use parking_lot::Mutex;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::{Child, Command};

use super::{Sidecar, SidecarStatus};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct NodeSidecarConfig {
    pub node_bin: String,
    pub cli_entry: String,
    pub extra_args: Vec<String>,
    pub cwd: Option<std::path::PathBuf>,
}

impl Default for NodeSidecarConfig {
    fn default() -> Self {
        Self {
            node_bin: "node".to_string(),
            cli_entry: String::new(),
            extra_args: Vec::new(),
            cwd: None,
        }
    }
}

#[derive(Debug, Default)]
struct State {
    child: Option<Child>,
    status: SidecarStatus,
}

#[derive(Debug, Clone)]
pub struct NodeSidecar {
    cfg: NodeSidecarConfig,
    state: Arc<Mutex<State>>,
}

impl NodeSidecar {
    pub fn new(cfg: NodeSidecarConfig) -> Self {
        Self {
            cfg,
            state: Arc::new(Mutex::new(State::default())),
        }
    }
}

#[async_trait]
impl Sidecar for NodeSidecar {
    async fn start(&self) -> AppResult<()> {
        {
            let s = self.state.lock();
            if matches!(s.status, SidecarStatus::Starting | SidecarStatus::Running) {
                return Ok(());
            }
        }
        self.state.lock().status = SidecarStatus::Starting;

        let mut cmd = Command::new(&self.cfg.node_bin);
        cmd.arg(&self.cfg.cli_entry).arg("serve");
        for a in &self.cfg.extra_args {
            cmd.arg(a);
        }
        if let Some(cwd) = &self.cfg.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let child = cmd
            .spawn()
            .map_err(|e| AppError::SidecarStart(format!("spawn {}: {e}", self.cfg.node_bin)))?;

        let mut s = self.state.lock();
        s.child = Some(child);
        // Optimistic — Phase 1 layer flips us to Running once the socket connects.
        s.status = SidecarStatus::Running;
        Ok(())
    }

    async fn stop(&self) -> AppResult<()> {
        let child = { self.state.lock().child.take() };
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.state.lock().status = SidecarStatus::Stopped;
        Ok(())
    }

    fn status(&self) -> SidecarStatus {
        self.state.lock().status
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalid_node_bin_returns_a_sidecar_start_error() {
        let sc = NodeSidecar::new(NodeSidecarConfig {
            node_bin: "/path/does/not/exist/__no_node__".into(),
            cli_entry: "irrelevant".into(),
            ..Default::default()
        });
        let err = sc.start().await.unwrap_err();
        assert!(matches!(err, AppError::SidecarStart(_)));
        assert_ne!(sc.status(), SidecarStatus::Running);
    }

    #[tokio::test]
    async fn stop_is_idempotent_when_never_started() {
        let sc = NodeSidecar::new(NodeSidecarConfig::default());
        sc.stop().await.unwrap();
        assert_eq!(sc.status(), SidecarStatus::Stopped);
        sc.stop().await.unwrap();
        assert_eq!(sc.status(), SidecarStatus::Stopped);
    }
}
