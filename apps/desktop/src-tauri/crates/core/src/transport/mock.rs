//! In-memory transport for tests.

use async_trait::async_trait;
use parking_lot::Mutex;
use std::sync::Arc;
use tokio::io::{duplex, DuplexStream as TokioDuplex};

use super::{DuplexStream, RunnerTransport};
use crate::error::AppResult;

#[derive(Default)]
pub struct PairedTransport {
    inbox: Arc<Mutex<Option<TokioDuplex>>>,
}

impl PairedTransport {
    pub fn paired() -> (Self, TokioDuplex) {
        let (a, b) = duplex(8192);
        let transport = Self {
            inbox: Arc::new(Mutex::new(Some(a))),
        };
        (transport, b)
    }

    pub fn seed(&self, stream: TokioDuplex) {
        *self.inbox.lock() = Some(stream);
    }
}

#[async_trait]
impl RunnerTransport for PairedTransport {
    async fn connect(&self) -> AppResult<Box<dyn DuplexStream>> {
        let stream = self
            .inbox
            .lock()
            .take()
            .ok_or_else(|| crate::error::AppError::Protocol("transport already consumed".into()))?;
        Ok(Box::new(stream))
    }

    fn endpoint(&self) -> &'static str {
        "<mock-paired-transport>"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn paired_streams_round_trip_bytes() {
        let (transport, mut server) = PairedTransport::paired();
        let mut client = transport.connect().await.unwrap();
        client.write_all(b"hello").await.unwrap();
        let mut buf = [0u8; 5];
        server.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");
    }

    #[tokio::test]
    async fn second_connect_without_seed_is_an_error() {
        let (transport, _server) = PairedTransport::paired();
        let _first = transport.connect().await.unwrap();
        match transport.connect().await {
            Err(crate::error::AppError::Protocol(_)) => {}
            other => panic!("expected Err(Protocol), got {:?}", other.map(|_| "ok")),
        }
    }
}
