//! Transport trait — opens a duplex byte stream to the runner.

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};

pub mod mock;
pub mod unix;

pub trait DuplexStream: AsyncRead + AsyncWrite + Send + Unpin + 'static {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin + 'static> DuplexStream for T {}

#[async_trait]
pub trait RunnerTransport: Send + Sync + 'static {
    async fn connect(&self) -> crate::error::AppResult<Box<dyn DuplexStream>>;
    fn endpoint(&self) -> &str;
}

pub async fn is_runner_up(transport: &dyn RunnerTransport) -> bool {
    matches!(
        tokio::time::timeout(std::time::Duration::from_millis(250), transport.connect()).await,
        Ok(Ok(_))
    )
}
