//! Bidirectional NDJSON-framed JSON-RPC peer.
//!
//! Mirrors the wire format of `packages/runner/src/jsonrpc.ts` so the Rust
//! peer can talk to the moxxy runner unmodified:
//!
//!   request      { "id": N, "method": "...", "params": ... }
//!   response     { "id": N, "result": ... }  |  { "id": N, "error": {...} }
//!   notification { "method": "...", "params": ... }
//!
//! Frames are separated by `\n` (NDJSON). Both peers are symmetric — either
//! side can issue requests, answer requests, or fire notifications. The
//! runner uses this to push `permission.check` requests back at us during
//! a turn; the desktop uses it for everything else.
//!
//! ## Concurrency
//!
//! On `mount`, two tasks spawn:
//!
//!   * **Writer**: drains an unbounded mpsc channel and writes each frame
//!     with a trailing `\n`. A bounded channel would risk deadlock — a
//!     request handler could be blocked waiting to send its reply while
//!     the writer is blocked waiting on backpressure.
//!   * **Reader**: parses NDJSON, classifies each frame, and dispatches:
//!     responses correlate via a `Mutex<HashMap<id, oneshot>>`; requests
//!     and notifications are handed to registered handlers.
//!
//! When the transport closes, every pending request rejects with
//! `RpcError::Closed`, both tasks exit, and `is_closed()` flips.

use parking_lot::Mutex;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinHandle;

use crate::transport::DuplexStream;

/// Wire-level error from a failed request or a closed link.
#[derive(Debug, Clone, Error)]
pub enum RpcError {
    #[error("rpc error: {message}")]
    Remote { message: String, data: Option<Value> },
    #[error("rpc peer is closed")]
    Closed,
    #[error("rpc decode: {0}")]
    Decode(String),
    #[error("rpc method not found: {0}")]
    UnknownMethod(String),
}

type RequestHandler = Arc<
    dyn Fn(Value) -> futures_util::future::BoxFuture<'static, Result<Value, RpcError>>
        + Send
        + Sync,
>;
type NotificationHandler = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Default)]
struct Handlers {
    requests: HashMap<String, RequestHandler>,
    notifications: HashMap<String, NotificationHandler>,
}

/// One end of a JSON-RPC link. Cheap to clone — internal state is shared.
#[derive(Clone)]
pub struct JsonRpcPeer {
    inner: Arc<PeerInner>,
}

struct PeerInner {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>,
    handlers: Mutex<Handlers>,
    outbound: mpsc::UnboundedSender<Value>,
    closed: AtomicBool,
    /// Wakes the writer task on close so it doesn't sit forever on an
    /// idle outbound channel after the reader has signalled EOF.
    shutdown: Arc<Notify>,
    /// Held until [`JsonRpcPeer::start`] runs; then taken and handed to
    /// the writer task. `None` after start; double-`start` panics.
    pending_outbound: Mutex<Option<mpsc::UnboundedReceiver<Value>>>,
}

/// Handle to the read/write tasks. Dropping it closes the peer.
pub struct PeerTasks {
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
}

impl PeerTasks {
    /// Wait for both tasks to finish — happens when the transport closes.
    pub async fn join(self) {
        let _ = self.reader.await;
        let _ = self.writer.await;
    }
}

impl JsonRpcPeer {
    /// Two-phase construction: build a peer detached from any transport,
    /// register handlers on it, **then** call [`Self::start`] with the
    /// stream. Spawning the reader before handlers are registered would
    /// race incoming frames against handler registration — a notification
    /// arriving in that gap would be dropped and a waiter would hang.
    pub fn new() -> Self {
        let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<Value>();
        Self {
            inner: Arc::new(PeerInner {
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                handlers: Mutex::new(Handlers::default()),
                outbound: outbound_tx,
                closed: AtomicBool::new(false),
                shutdown: Arc::new(Notify::new()),
                pending_outbound: Mutex::new(Some(outbound_rx)),
            }),
        }
    }

    /// Spawn the reader + writer tasks on `stream`. Call once after every
    /// handler is registered. Returns a handle for tests that want to
    /// `.join().await` on shutdown.
    pub fn start(&self, stream: Box<dyn DuplexStream>) -> PeerTasks {
        let outbound_rx = self
            .inner
            .pending_outbound
            .lock()
            .take()
            .expect("JsonRpcPeer::start called twice");

        let (read_half, write_half) = tokio::io::split(stream);
        let writer = tokio::spawn(writer_task(
            write_half,
            outbound_rx,
            Arc::clone(&self.inner),
        ));
        let reader = tokio::spawn(reader_task(read_half, self.clone()));
        PeerTasks { reader, writer }
    }

    /// Convenience for callers that don't need to register handlers up
    /// front (e.g. a fire-and-forget request-only client). Equivalent to
    /// `let p = new(); let t = p.start(stream); (p, t)`.
    pub fn mount(stream: Box<dyn DuplexStream>) -> (Self, PeerTasks) {
        let peer = Self::new();
        let tasks = peer.start(stream);
        (peer, tasks)
    }
}

impl Default for JsonRpcPeer {
    fn default() -> Self {
        Self::new()
    }
}

impl JsonRpcPeer {
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// Issue a request and await the reply. Rejects with [`RpcError::Closed`]
    /// if the link drops before a response arrives.
    pub async fn request<T: DeserializeOwned, P: Serialize>(
        &self,
        method: &str,
        params: P,
    ) -> Result<T, RpcError> {
        if self.is_closed() {
            return Err(RpcError::Closed);
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().insert(id, tx);

        let params_val = serde_json::to_value(params)
            .map_err(|e| RpcError::Decode(format!("encode params: {e}")))?;

        let frame = serde_json::json!({
            "id": id,
            "method": method,
            "params": params_val,
        });
        if self.inner.outbound.send(frame).is_err() {
            // Writer task is gone — abandon the pending entry.
            self.inner.pending.lock().remove(&id);
            return Err(RpcError::Closed);
        }

        match rx.await {
            Ok(Ok(v)) => serde_json::from_value(v)
                .map_err(|e| RpcError::Decode(format!("decode response: {e}"))),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(RpcError::Closed),
        }
    }

    /// Fire a notification. No reply expected; silently drops if closed.
    pub fn notify<P: Serialize>(&self, method: &str, params: P) {
        if self.is_closed() {
            return;
        }
        let Ok(params_val) = serde_json::to_value(params) else {
            return;
        };
        let frame = serde_json::json!({
            "method": method,
            "params": params_val,
        });
        let _ = self.inner.outbound.send(frame);
    }

    /// Register a request handler. Last registration wins (matches the TS peer).
    pub fn on_request<F, Fut>(&self, method: impl Into<String>, f: F)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<Value, RpcError>> + Send + 'static,
    {
        use futures_util::FutureExt;
        let wrapped: RequestHandler = Arc::new(move |p| f(p).boxed());
        self.inner
            .handlers
            .lock()
            .requests
            .insert(method.into(), wrapped);
    }

    /// Register a notification handler.
    pub fn on_notification<F>(&self, method: impl Into<String>, f: F)
    where
        F: Fn(Value) + Send + Sync + 'static,
    {
        self.inner
            .handlers
            .lock()
            .notifications
            .insert(method.into(), Arc::new(f));
    }

    fn close(&self) {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        // Reject every waiter.
        let pending: Vec<_> = self
            .inner
            .pending
            .lock()
            .drain()
            .map(|(_, tx)| tx)
            .collect();
        for tx in pending {
            let _ = tx.send(Err(RpcError::Closed));
        }
        // Wake the writer so it can exit even though the outbound
        // channel still has live senders (held inside `Arc<PeerInner>`).
        self.inner.shutdown.notify_waiters();
    }
}

async fn writer_task<W: tokio::io::AsyncWrite + Unpin + Send>(
    mut writer: W,
    mut rx: mpsc::UnboundedReceiver<Value>,
    inner: Arc<PeerInner>,
) {
    let shutdown = Arc::clone(&inner.shutdown);
    loop {
        // Race a queued outbound frame against a close signal so the
        // writer exits promptly when the reader sees EOF — even if the
        // outbound channel still has live senders (it always does:
        // PeerInner owns one).
        tokio::select! {
            biased;
            () = shutdown.notified() => break,
            frame = rx.recv() => {
                let Some(frame) = frame else { break };
                let line = match serde_json::to_vec(&frame) {
                    Ok(mut bytes) => { bytes.push(b'\n'); bytes }
                    Err(_) => continue,
                };
                if writer.write_all(&line).await.is_err() {
                    break;
                }
            }
        }
    }
    inner.closed.store(true, Ordering::SeqCst);
    let pending: Vec<_> = inner
        .pending
        .lock()
        .drain()
        .map(|(_, tx)| tx)
        .collect();
    for tx in pending {
        let _ = tx.send(Err(RpcError::Closed));
    }
}

async fn reader_task<R: tokio::io::AsyncRead + Unpin + Send>(
    reader: R,
    peer: JsonRpcPeer,
) {
    let mut lines = BufReader::new(reader).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.is_empty() {
                    continue;
                }
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    // Malformed frame — log and skip; never let it kill the peer.
                    tracing::warn!(line = %line, "rpc: dropping malformed frame");
                    continue;
                };
                handle_frame(&peer, frame);
            }
            Ok(None) | Err(_) => break,
        }
    }
    peer.close();
}

fn handle_frame(peer: &JsonRpcPeer, frame: Value) {
    let id = frame.get("id").and_then(Value::as_u64);
    let method = frame.get("method").and_then(Value::as_str).map(str::to_string);

    match (id, method) {
        (Some(id), Some(method)) => {
            // Request — dispatch to handler.
            let params = frame.get("params").cloned().unwrap_or(Value::Null);
            let handler = peer.inner.handlers.lock().requests.get(&method).cloned();
            let peer_clone = peer.clone();
            tokio::spawn(async move {
                let response = match handler {
                    Some(h) => match h(params).await {
                        Ok(v) => serde_json::json!({ "id": id, "result": v }),
                        Err(RpcError::Remote { message, data }) => serde_json::json!({
                            "id": id,
                            "error": { "message": message, "data": data }
                        }),
                        Err(other) => serde_json::json!({
                            "id": id,
                            "error": { "message": other.to_string() }
                        }),
                    },
                    None => serde_json::json!({
                        "id": id,
                        "error": { "message": format!("unknown method: {method}") }
                    }),
                };
                let _ = peer_clone.inner.outbound.send(response);
            });
        }
        (None, Some(method)) => {
            // Notification — invoke handler if any (best-effort).
            let params = frame.get("params").cloned().unwrap_or(Value::Null);
            if let Some(h) = peer.inner.handlers.lock().notifications.get(&method).cloned() {
                // Run synchronously; notification handlers are expected to be cheap
                // (they typically just push onto a broadcast channel).
                h(params);
            }
        }
        (Some(id), None) => {
            // Response.
            let waiter = peer.inner.pending.lock().remove(&id);
            if let Some(tx) = waiter {
                let result = if let Some(err) = frame.get("error") {
                    let message = err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("(no message)")
                        .to_string();
                    let data = err.get("data").cloned();
                    Err(RpcError::Remote { message, data })
                } else {
                    Ok(frame.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(result);
            }
        }
        (None, None) => { /* malformed — already filtered by Value parsing */ }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::mock::PairedTransport;
    use crate::transport::RunnerTransport;
    use serde_json::json;
    use std::time::Duration;

    /// Test budget. If anything takes longer than this we want the test to
    /// fail loudly — never hang cargo waiting forever on a stuck oneshot.
    const TEST_TIMEOUT: Duration = Duration::from_secs(3);

    /// Wrap a future with [`TEST_TIMEOUT`]; panic on elapsed.
    async fn deadline<T>(label: &str, fut: impl std::future::Future<Output = T>) -> T {
        match tokio::time::timeout(TEST_TIMEOUT, fut).await {
            Ok(v) => v,
            Err(_) => panic!("test '{label}' exceeded {TEST_TIMEOUT:?} deadline"),
        }
    }

    /// Pump a server-side duplex by acting as a JSON-RPC peer ourselves —
    /// reads line, parses, dispatches a hand-coded response.
    async fn server_loop<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static>(
        stream: S,
        responder: impl Fn(Value) -> Option<Value> + Send + Sync + 'static,
    ) {
        let (read, mut write) = tokio::io::split(stream);
        let mut lines = BufReader::new(read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.is_empty() {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(reply) = responder(frame) {
                let mut bytes = serde_json::to_vec(&reply).unwrap();
                bytes.push(b'\n');
                if write.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        }
    }

    #[tokio::test]
    async fn request_round_trips_through_a_fake_server() {
        let (transport, server) = PairedTransport::paired();
        let server_handle = tokio::spawn(server_loop(server, |frame| {
            let id = frame.get("id")?.as_u64()?;
            let method = frame.get("method")?.as_str()?;
            assert_eq!(method, "ping");
            Some(json!({ "id": id, "result": "pong" }))
        }));

        let stream = transport.connect().await.unwrap();
        let (peer, _tasks) = JsonRpcPeer::mount(stream);
        let reply: String = deadline("ping", peer.request("ping", json!({}))).await.unwrap();
        assert_eq!(reply, "pong");
        server_handle.abort();
    }

    #[tokio::test]
    async fn remote_errors_surface_as_rpc_error_remote() {
        let (transport, server) = PairedTransport::paired();
        let _server = tokio::spawn(server_loop(server, |frame| {
            let id = frame.get("id")?.as_u64()?;
            Some(json!({
                "id": id,
                "error": { "message": "no such thing", "data": { "extra": 1 } }
            }))
        }));

        let stream = transport.connect().await.unwrap();
        let (peer, _tasks) = JsonRpcPeer::mount(stream);
        let err = deadline("noop", peer.request::<Value, _>("noop", json!({})))
            .await
            .unwrap_err();
        match err {
            RpcError::Remote { message, data } => {
                assert_eq!(message, "no such thing");
                assert!(data.is_some());
            }
            other => panic!("expected Remote, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn notifications_route_to_registered_handlers() {
        let (transport, server) = PairedTransport::paired();
        // Register the handler BEFORE the server's notification can race
        // through the reader. The two-phase API enforces this — calling
        // mount() here would have raced and hung the test.
        let stream = transport.connect().await.unwrap();
        let peer = JsonRpcPeer::new();
        let (tx, rx) = oneshot::channel();
        let tx = Mutex::new(Some(tx));
        peer.on_notification("event", move |params| {
            if let Some(tx) = tx.lock().take() {
                let _ = tx.send(params);
            }
        });
        let _tasks = peer.start(stream);

        let _server = tokio::spawn(async move {
            let (_, mut write) = tokio::io::split(server);
            let line = format!(
                "{}\n",
                json!({ "method": "event", "params": { "kind": "hello" } })
            );
            write.write_all(line.as_bytes()).await.unwrap();
            // Keep the connection open so the client's reader doesn't
            // close before the notification dispatch completes.
            std::future::pending::<()>().await;
        });

        let received = deadline("notification", rx).await.unwrap();
        assert_eq!(received["kind"], "hello");
    }

    #[tokio::test]
    async fn pending_requests_reject_when_the_link_closes() {
        let (transport, server) = PairedTransport::paired();
        let server_handle = tokio::spawn(async move {
            let (read, _write) = tokio::io::split(server);
            let mut lines = BufReader::new(read).lines();
            let _ = lines.next_line().await;
            // Drop everything → close.
        });

        let stream = transport.connect().await.unwrap();
        let (peer, tasks) = JsonRpcPeer::mount(stream);
        let result = deadline("ping", peer.request::<Value, _>("ping", json!({}))).await;
        assert!(matches!(result, Err(RpcError::Closed)));
        server_handle.abort();
        deadline("join tasks", tasks.join()).await;
        assert!(peer.is_closed());
    }

    #[tokio::test]
    async fn unknown_request_methods_get_an_error_reply() {
        let (transport, server) = PairedTransport::paired();
        let server_handle = tokio::spawn(async move {
            // Server side: send a request to the client for a method the
            // client hasn't registered, then read the error reply.
            let (read, mut write) = tokio::io::split(server);
            let req = format!(
                "{}\n",
                json!({ "id": 1, "method": "noop", "params": null })
            );
            write.write_all(req.as_bytes()).await.unwrap();

            let mut lines = BufReader::new(read).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let reply: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(reply["id"], 1);
            assert!(reply["error"]["message"].as_str().unwrap().contains("noop"));
        });

        let stream = transport.connect().await.unwrap();
        let (_peer, tasks) = JsonRpcPeer::mount(stream);
        deadline("server_handle", server_handle).await.unwrap();
        drop(tasks);
    }

    #[tokio::test]
    async fn registered_request_handlers_produce_replies() {
        let (transport, server) = PairedTransport::paired();
        // Register the request handler BEFORE start() so the inbound
        // server request can't race ahead of the handler registration.
        let stream = transport.connect().await.unwrap();
        let peer = JsonRpcPeer::new();
        peer.on_request("double", |params: Value| async move {
            let n = params["n"].as_i64().unwrap_or(0);
            Ok(json!({ "n": n * 2 }))
        });
        let _tasks = peer.start(stream);

        let server_handle = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let req = format!(
                "{}\n",
                json!({ "id": 7, "method": "double", "params": { "n": 21 } })
            );
            write.write_all(req.as_bytes()).await.unwrap();

            let mut lines = BufReader::new(read).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let reply: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(reply["id"], 7);
            assert_eq!(reply["result"]["n"], 42);
        });
        deadline("server_handle", server_handle).await.unwrap();
    }

    #[tokio::test]
    async fn malformed_frames_are_dropped_silently() {
        let (transport, server) = PairedTransport::paired();
        // Register the handler BEFORE starting the reader so the valid
        // notification (which follows the garbage line) can't be dispatched
        // into a registry that doesn't yet know about "event".
        let stream = transport.connect().await.unwrap();
        let peer = JsonRpcPeer::new();
        let (tx, rx) = oneshot::channel();
        let tx = Mutex::new(Some(tx));
        peer.on_notification("event", move |p| {
            if let Some(tx) = tx.lock().take() {
                let _ = tx.send(p);
            }
        });
        let _tasks = peer.start(stream);

        let server_handle = tokio::spawn(async move {
            let (_, mut write) = tokio::io::split(server);
            write.write_all(b"{not json\n").await.unwrap();
            let valid = format!(
                "{}\n",
                json!({ "method": "event", "params": "ok" })
            );
            write.write_all(valid.as_bytes()).await.unwrap();
            std::future::pending::<()>().await;
        });

        let got = deadline("notification", rx).await.unwrap();
        assert_eq!(got.as_str(), Some("ok"));
        server_handle.abort();
    }
}
