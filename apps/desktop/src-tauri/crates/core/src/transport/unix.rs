//! Unix-socket / named-pipe transport. Mirrors the runner's own socket
//! resolution rules from `packages/runner/src/socket-path.ts`.

use async_trait::async_trait;

use super::{DuplexStream, RunnerTransport};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct UnixTransport {
    path: String,
}

impl UnixTransport {
    pub fn default_path() -> AppResult<Self> {
        if let Ok(path) = std::env::var("MOXXY_RUNNER_SOCKET") {
            return Ok(Self::with_path(path));
        }

        #[cfg(windows)]
        {
            return Ok(Self::with_path(r"\\.\pipe\moxxy-serve".to_string()));
        }

        #[cfg(not(windows))]
        {
            let home = dirs::home_dir().ok_or(AppError::NoConfigDir)?;
            let p: std::path::PathBuf = home.join(".moxxy").join("serve.sock");
            Ok(Self::with_path(p.to_string_lossy().into_owned()))
        }
    }

    pub fn with_path(path: impl Into<String>) -> Self {
        Self { path: path.into() }
    }
}

#[async_trait]
impl RunnerTransport for UnixTransport {
    #[cfg(unix)]
    async fn connect(&self) -> AppResult<Box<dyn DuplexStream>> {
        let stream = tokio::net::UnixStream::connect(&self.path).await?;
        Ok(Box::new(stream))
    }

    #[cfg(windows)]
    async fn connect(&self) -> AppResult<Box<dyn DuplexStream>> {
        use tokio::net::windows::named_pipe::ClientOptions;
        let pipe = ClientOptions::new()
            .open(&self.path)
            .map_err(AppError::Io)?;
        Ok(Box::new(pipe))
    }

    fn endpoint(&self) -> &str {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins_over_defaults() {
        let _guard = EnvGuard::set("MOXXY_RUNNER_SOCKET", "/tmp/test.sock");
        let t = UnixTransport::default_path().unwrap();
        assert_eq!(t.endpoint(), "/tmp/test.sock");
    }

    #[test]
    fn default_resolves_under_home_dir_on_unix() {
        let _guard = EnvGuard::unset("MOXXY_RUNNER_SOCKET");
        let t = UnixTransport::default_path().unwrap();
        #[cfg(unix)]
        {
            let expected = dirs::home_dir().unwrap().join(".moxxy").join("serve.sock");
            assert_eq!(t.endpoint(), expected.to_string_lossy());
        }
        #[cfg(windows)]
        {
            assert_eq!(t.endpoint(), r"\\.\pipe\moxxy-serve");
        }
    }

    #[tokio::test]
    async fn connect_to_a_nonexistent_socket_yields_an_io_error() {
        let t = UnixTransport::with_path("/tmp/__moxxy_test_no_such_socket__.sock");
        match t.connect().await {
            Err(AppError::Io(_)) => {}
            other => panic!("expected Err(Io), got {:?}", other.map(|_| "ok")),
        }
    }

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }
    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }
        fn unset(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, previous }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }
}
