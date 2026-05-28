//! Desks — the user's workspaces. A desk is a name + bound directory +
//! cosmetic color; sessions live under it.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub mod json_store;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeskId(String);

impl DeskId {
    pub fn new(raw: impl Into<String>) -> crate::error::AppResult<Self> {
        let raw = raw.into();
        if raw.is_empty() || raw.len() > 64 {
            return Err(crate::error::AppError::InvalidDeskId(raw));
        }
        if !raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(crate::error::AppError::InvalidDeskId(raw));
        }
        Ok(Self(raw))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for DeskId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Desk {
    pub id: DeskId,
    pub name: String,
    pub dir: PathBuf,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeskDoc {
    pub version: u32,
    pub active: Option<DeskId>,
    pub desks: Vec<Desk>,
}

impl Default for DeskDoc {
    fn default() -> Self {
        Self {
            version: Self::CURRENT_VERSION,
            active: None,
            desks: Vec::new(),
        }
    }
}

impl DeskDoc {
    pub const CURRENT_VERSION: u32 = 1;
}

#[async_trait]
pub trait DeskStore: Send + Sync + 'static {
    async fn list(&self) -> crate::error::AppResult<Vec<Desk>>;
    async fn upsert(&self, desk: Desk) -> crate::error::AppResult<()>;
    async fn remove(&self, id: &DeskId) -> crate::error::AppResult<()>;
    async fn set_active(&self, id: &DeskId) -> crate::error::AppResult<()>;
    async fn active(&self) -> crate::error::AppResult<Option<DeskId>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desk_id_accepts_url_safe_strings() {
        DeskId::new("personal").unwrap();
        DeskId::new("blocky-app").unwrap();
        DeskId::new("side_project_42").unwrap();
        DeskId::new("a").unwrap();
    }

    #[test]
    fn desk_id_rejects_unsafe_or_empty_strings() {
        for bad in [
            "",
            "  ",
            "with space",
            "slash/in/it",
            "dots.in.it",
            "\u{1F4A9}",
            &"a".repeat(65),
        ] {
            let err = DeskId::new(bad).unwrap_err();
            assert!(matches!(err, crate::error::AppError::InvalidDeskId(_)));
        }
    }

    #[test]
    fn doc_round_trips_through_json() {
        let doc = DeskDoc {
            version: 1,
            active: Some(DeskId::new("personal").unwrap()),
            desks: vec![Desk {
                id: DeskId::new("personal").unwrap(),
                name: "Personal".into(),
                dir: PathBuf::from("/home/me/notes"),
                color: "#818cf8".into(),
                provider: None,
                model: None,
            }],
        };
        let s = serde_json::to_string(&doc).unwrap();
        let parsed: DeskDoc = serde_json::from_str(&s).unwrap();
        assert_eq!(doc, parsed);
    }

    #[test]
    fn optional_fields_drop_when_none() {
        let desk = Desk {
            id: DeskId::new("personal").unwrap(),
            name: "Personal".into(),
            dir: PathBuf::from("/x"),
            color: "#fff".into(),
            provider: None,
            model: None,
        };
        let s = serde_json::to_string(&desk).unwrap();
        assert!(!s.contains("provider"));
        assert!(!s.contains("model"));
    }
}
