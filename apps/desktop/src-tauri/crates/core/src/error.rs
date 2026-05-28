use serde::Serialize;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("invalid desk id: {0}")]
    InvalidDeskId(String),

    #[error("desk not found: {0}")]
    DeskNotFound(String),

    #[error("path not allowed: {0}")]
    PathNotAllowed(PathBuf),

    #[error("sidecar failed to start: {0}")]
    SidecarStart(String),

    #[error("runner protocol error: {0}")]
    Protocol(String),

    #[error("config dir is unavailable")]
    NoConfigDir,
}

pub type AppResult<T> = Result<T, AppError>;

impl Serialize for AppError {
    fn serialize<S>(&self, ser: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        ser.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_lift_into_appresult() {
        fn fallible() -> AppResult<()> {
            std::fs::read_to_string("/path/that/does/not/exist/at/all")?;
            Ok(())
        }
        let err = fallible().unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert!(err.to_string().contains("io error"));
    }

    #[test]
    fn errors_serialise_to_strings() {
        let err = AppError::DeskNotFound("personal".into());
        let s = serde_json::to_string(&err).unwrap();
        assert_eq!(s, "\"desk not found: personal\"");
    }
}
