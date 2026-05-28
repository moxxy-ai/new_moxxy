//! Sidecar trait — anything the supervisor can boot, kill, and interrogate.
//! Default impl is [`node::NodeSidecar`]; tests use [`mock::MockSidecar`].

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub mod mock;
pub mod node;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarStatus {
    Starting,
    Running,
    Crashed,
    #[default]
    Stopped,
}

impl SidecarStatus {
    pub const EVENT_NAME: &'static str = "sidecar.status";

    pub fn is_healthy(self) -> bool {
        matches!(self, Self::Running)
    }
}

#[async_trait]
pub trait Sidecar: Send + Sync + 'static {
    async fn start(&self) -> crate::error::AppResult<()>;
    async fn stop(&self) -> crate::error::AppResult<()>;
    fn status(&self) -> SidecarStatus;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serialises_in_lowercase_for_js_consumption() {
        assert_eq!(
            serde_json::to_string(&SidecarStatus::Running).unwrap(),
            "\"running\""
        );
        assert_eq!(
            serde_json::to_string(&SidecarStatus::Starting).unwrap(),
            "\"starting\""
        );
        assert_eq!(
            serde_json::to_string(&SidecarStatus::Crashed).unwrap(),
            "\"crashed\""
        );
        assert_eq!(
            serde_json::to_string(&SidecarStatus::Stopped).unwrap(),
            "\"stopped\""
        );
    }

    #[test]
    fn only_running_is_healthy() {
        assert!(SidecarStatus::Running.is_healthy());
        assert!(!SidecarStatus::Starting.is_healthy());
        assert!(!SidecarStatus::Crashed.is_healthy());
        assert!(!SidecarStatus::Stopped.is_healthy());
    }

    #[test]
    fn status_event_name_is_stable() {
        assert_eq!(SidecarStatus::EVENT_NAME, "sidecar.status");
    }
}
