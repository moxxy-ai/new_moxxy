//! Test double for [`Sidecar`].
//!
//! ```no_run
//! use moxxy_desktop_core::sidecar::{mock::MockSidecar, Sidecar, SidecarStatus};
//! let sidecar = MockSidecar::new();
//! sidecar.set_status(SidecarStatus::Running);
//! assert!(sidecar.status().is_healthy());
//! ```

use async_trait::async_trait;
use parking_lot::Mutex;
use std::sync::Arc;

use super::{Sidecar, SidecarStatus};
use crate::error::{AppError, AppResult};

#[derive(Debug, Default)]
struct State {
    status: SidecarStatus,
    starts: u32,
    stops: u32,
    fail_next_start: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct MockSidecar {
    state: Arc<Mutex<State>>,
}

impl MockSidecar {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_status(status: SidecarStatus) -> Self {
        let me = Self::new();
        me.set_status(status);
        me
    }

    pub fn set_status(&self, status: SidecarStatus) {
        self.state.lock().status = status;
    }

    pub fn fail_next_start(&self, msg: impl Into<String>) {
        self.state.lock().fail_next_start = Some(msg.into());
    }

    pub fn start_calls(&self) -> u32 {
        self.state.lock().starts
    }

    pub fn stop_calls(&self) -> u32 {
        self.state.lock().stops
    }
}

#[async_trait]
impl Sidecar for MockSidecar {
    async fn start(&self) -> AppResult<()> {
        let mut state = self.state.lock();
        state.starts += 1;
        if let Some(msg) = state.fail_next_start.take() {
            state.status = SidecarStatus::Crashed;
            return Err(AppError::SidecarStart(msg));
        }
        state.status = SidecarStatus::Running;
        Ok(())
    }

    async fn stop(&self) -> AppResult<()> {
        let mut state = self.state.lock();
        state.stops += 1;
        state.status = SidecarStatus::Stopped;
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
    async fn start_transitions_to_running_and_records_the_call() {
        let sc = MockSidecar::new();
        assert_eq!(sc.status(), SidecarStatus::Stopped);
        sc.start().await.unwrap();
        assert_eq!(sc.status(), SidecarStatus::Running);
        assert_eq!(sc.start_calls(), 1);
    }

    #[tokio::test]
    async fn stop_transitions_to_stopped_and_records_the_call() {
        let sc = MockSidecar::with_status(SidecarStatus::Running);
        sc.stop().await.unwrap();
        assert_eq!(sc.status(), SidecarStatus::Stopped);
        assert_eq!(sc.stop_calls(), 1);
    }

    #[tokio::test]
    async fn fail_next_start_only_fires_once() {
        let sc = MockSidecar::new();
        sc.fail_next_start("simulated boot failure");
        let first = sc.start().await;
        assert!(first.is_err());
        assert_eq!(sc.status(), SidecarStatus::Crashed);

        sc.start().await.unwrap();
        assert_eq!(sc.status(), SidecarStatus::Running);
    }

    #[tokio::test]
    async fn clone_shares_state_via_arc() {
        let a = MockSidecar::new();
        let b = a.clone();
        a.start().await.unwrap();
        assert_eq!(b.status(), SidecarStatus::Running);
        assert_eq!(b.start_calls(), 1);
    }
}
