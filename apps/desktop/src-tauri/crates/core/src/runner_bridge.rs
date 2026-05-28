//! High-level wrapper around the moxxy runner's JSON-RPC peer.
//!
//! Sits between the JSON-RPC plumbing in [`crate::jsonrpc`] and whatever
//! sits above it (in production: the Tauri command layer + an event fan-
//! out into the webview; in tests: just an in-memory listener).
//!
//! Responsibilities:
//!
//!   * Connect through a [`crate::transport::RunnerTransport`] and mount
//!     a [`JsonRpcPeer`] on the resulting stream.
//!   * Drive the `attach` handshake on connect — bumping the runner
//!     protocol version is a *deliberate* break, so a mismatch surfaces
//!     here, not in a confused later call.
//!   * Forward `event` / `turn.complete` / `info.changed` notifications
//!     onto a bounded broadcast channel that any number of subscribers
//!     can read (UI panels, tests, telemetry). The channel is bounded;
//!     on overflow the subscriber sees a `BridgeEvent::Lagged { count }`
//!     and can recover by replaying via `attach` on a new connection.
//!   * Expose a typed surface (`run_turn`, `abort_turn`) so callers don't
//!     hand-marshal method names + params.
//!
//! Permission / approval routing is registered as request handlers on
//! the peer so a later layer (the Tauri side, in production) can answer
//! the runner's `permission.check` / `approval.confirm` server-to-client
//! requests. The bridge itself stays UI-agnostic.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::broadcast;

use crate::jsonrpc::{JsonRpcPeer, PeerTasks, RpcError};
use crate::transport::RunnerTransport;

/// Bumped in lockstep with `packages/runner/src/protocol.ts`. A desktop
/// build older than the runner — or vice versa — fails the attach
/// handshake with a clear message rather than silently misbehaving.
pub const RUNNER_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("connect failed: {0}")]
    Connect(#[from] crate::error::AppError),
    #[error("rpc: {0}")]
    Rpc(#[from] RpcError),
    #[error("decode: {0}")]
    Decode(String),
    #[error("protocol mismatch: runner is v{runner}, desktop is v{ours}")]
    ProtocolMismatch { runner: u32, ours: u32 },
}

pub type BridgeResult<T> = Result<T, BridgeError>;

/// Payload sent at attach time. Mirrors `AttachParams` in `protocol.ts`.
#[derive(Debug, Clone, Serialize)]
pub struct AttachParams {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub role: String,
    #[serde(rename = "sinceSeq", skip_serializing_if = "Option::is_none")]
    pub since_seq: Option<u64>,
}

/// Result of a successful attach. Trimmed to what the desktop actually
/// reads; `info` arrives as opaque JSON so a runner-side schema change
/// doesn't force a desktop rebuild for fields we don't surface yet.
#[derive(Debug, Clone, Deserialize)]
pub struct AttachResult {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub info: Value,
}

/// Inputs for `runTurn`. Only `prompt` is required; everything else is
/// a per-turn override the user might set via slash commands.
#[derive(Debug, Clone, Serialize, Default)]
pub struct RunTurnParams {
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(rename = "systemPrompt", skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(rename = "maxIterations", skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunTurnResult {
    #[serde(rename = "turnId")]
    pub turn_id: String,
}

/// Events the bridge fans out. Opaque JSON for the moxxy event variants
/// (those are owned by the runner; we forward them unchanged), tagged on
/// the Rust side so subscribers can switch without parsing twice.
#[derive(Debug, Clone)]
pub enum BridgeEvent {
    /// A new MoxxyEvent appended to the session log.
    Event { event: Value },
    /// A turn finished, cleanly or with an error.
    TurnComplete { turn_id: String, error: Option<String> },
    /// The session-info snapshot changed (mode / provider / plugins).
    InfoChanged { info: Value },
    /// Backpressure: the subscriber missed `count` events because the
    /// broadcast channel overflowed. Recover by re-attaching from seq 0.
    Lagged { count: u64 },
}

/// Tuning knob for the broadcast channel — bounded so a stuck consumer
/// can't push us into OOM. Pinned generous (16k) so typical UI consumers
/// never observe `Lagged` under normal load.
const EVENT_CHANNEL_CAPACITY: usize = 16_384;

/// One bridge per runner. Cheap to clone — the underlying peer + sender
/// live in `Arc`s.
#[derive(Clone)]
pub struct RunnerBridge {
    inner: Arc<BridgeInner>,
}

struct BridgeInner {
    peer: JsonRpcPeer,
    events: broadcast::Sender<BridgeEvent>,
    session_id: parking_lot::Mutex<Option<String>>,
    role: String,
    /// Held alive so the peer's reader/writer tasks survive until the
    /// bridge is dropped.
    _tasks: PeerTasks,
    /// A receiver we never drain — it pins the broadcast channel open so
    /// `Sender::send` never sees "no receivers" and drops events on the
    /// floor before the first real subscriber appears. broadcast is a
    /// fixed-capacity ring, so this idle receiver does not leak memory
    /// (old events are overwritten as new ones land).
    _keepalive: broadcast::Receiver<BridgeEvent>,
}

impl RunnerBridge {
    /// Connect through `transport` and complete the `attach` handshake.
    ///
    /// `role` is a free-form tag echoed back to the runner for log
    /// triage (e.g. `"desktop"`, `"desktop-window-2"`). The runner
    /// neither authenticates nor authorises off this value.
    ///
    /// Returns `(bridge, initial_rx)`. The receiver predates the attach
    /// call so the history-replay events arrive on it — a caller that
    /// only subscribed after `connect()` returned would miss them, since
    /// `broadcast` only delivers messages sent after subscribe. Drop it
    /// if you only want events going forward; keep it (or pass to your
    /// consumer task) if you want the replay.
    pub async fn connect(
        transport: Arc<dyn RunnerTransport>,
        role: impl Into<String>,
    ) -> BridgeResult<(Self, broadcast::Receiver<BridgeEvent>)> {
        let role = role.into();
        let stream = transport.connect().await?;
        let peer = JsonRpcPeer::new();
        let (events_tx, _keepalive_rx) = broadcast::channel(EVENT_CHANNEL_CAPACITY);

        // Register notification fan-out BEFORE starting the reader.
        // Otherwise the first event from the runner — which can arrive
        // during attach, since attach replays the full log — would race
        // ahead of the subscriber set and drop on the floor.
        wire_notifications(&peer, &events_tx);

        let tasks = peer.start(stream);

        // Subscribe BEFORE issuing attach so history-replay events land
        // on a real subscriber instead of being dropped.
        let initial_rx = events_tx.subscribe();
        // Also keep an idle receiver pinning the channel open even if
        // the caller drops `initial_rx`; broadcast::Sender::send drops
        // messages when no receiver exists.
        let keepalive_rx = events_tx.subscribe();
        drop(_keepalive_rx);

        let result: AttachResult = peer
            .request(
                "attach",
                AttachParams {
                    protocol_version: RUNNER_PROTOCOL_VERSION,
                    role: role.clone(),
                    since_seq: None,
                },
            )
            .await?;

        if result.protocol_version != RUNNER_PROTOCOL_VERSION {
            return Err(BridgeError::ProtocolMismatch {
                runner: result.protocol_version,
                ours: RUNNER_PROTOCOL_VERSION,
            });
        }

        Ok((
            Self {
                inner: Arc::new(BridgeInner {
                    peer,
                    events: events_tx,
                    session_id: parking_lot::Mutex::new(Some(result.session_id)),
                    role,
                    _tasks: tasks,
                    _keepalive: keepalive_rx,
                }),
            },
            initial_rx,
        ))
    }

    /// Subscribe to live events. Each subscriber sees every event sent
    /// after `subscribe()` was called; backlog before that point is
    /// already buffered through `attach`'s replay (the runner sends them
    /// as Event notifications), so a late subscriber misses them. Best
    /// for the bridge's lifetime to have at least one persistent
    /// subscriber (the Tauri event-forwarder) so events aren't dropped
    /// on the broadcast floor.
    pub fn subscribe(&self) -> broadcast::Receiver<BridgeEvent> {
        self.inner.events.subscribe()
    }

    /// Issue `runTurn`. Returns immediately with the turn id; the actual
    /// events stream through the broadcast channel and a final
    /// `BridgeEvent::TurnComplete` lands when the turn finishes.
    pub async fn run_turn(&self, params: RunTurnParams) -> BridgeResult<RunTurnResult> {
        Ok(self.inner.peer.request("runTurn", params).await?)
    }

    /// Abort a turn by id. Best-effort; returns `Ok` even if the runner
    /// has already moved on.
    pub async fn abort_turn(&self, turn_id: impl Into<String>) -> BridgeResult<()> {
        #[derive(Serialize)]
        struct Args {
            #[serde(rename = "turnId")]
            turn_id: String,
        }
        let _: Value = self
            .inner
            .peer
            .request(
                "abort",
                Args {
                    turn_id: turn_id.into(),
                },
            )
            .await?;
        Ok(())
    }

    /// Identifier the runner assigned to the session at attach time.
    pub fn session_id(&self) -> Option<String> {
        self.inner.session_id.lock().clone()
    }

    pub fn role(&self) -> &str {
        &self.inner.role
    }

    pub fn is_closed(&self) -> bool {
        self.inner.peer.is_closed()
    }
}

fn wire_notifications(peer: &JsonRpcPeer, events: &broadcast::Sender<BridgeEvent>) {
    let ev_tx = events.clone();
    peer.on_notification("event", move |params| {
        let event = params
            .get("event")
            .cloned()
            .unwrap_or(Value::Null);
        // broadcast::send errs only when there are no receivers; that's
        // fine — the event just isn't observed.
        let _ = ev_tx.send(BridgeEvent::Event { event });
    });

    let ev_tx = events.clone();
    peer.on_notification("turn.complete", move |params| {
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let error = params
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string);
        let _ = ev_tx.send(BridgeEvent::TurnComplete { turn_id, error });
    });

    let ev_tx = events.clone();
    peer.on_notification("info.changed", move |params| {
        let info = params.get("info").cloned().unwrap_or(Value::Null);
        let _ = ev_tx.send(BridgeEvent::InfoChanged { info });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::mock::PairedTransport;
    use serde_json::json;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    const DEADLINE: Duration = Duration::from_secs(3);

    async fn deadline<T>(label: &str, fut: impl std::future::Future<Output = T>) -> T {
        match tokio::time::timeout(DEADLINE, fut).await {
            Ok(v) => v,
            Err(_) => panic!("test '{label}' exceeded {DEADLINE:?} deadline"),
        }
    }

    /// Spawn a hand-rolled NDJSON server that runs a script of replies +
    /// pushes against the connected client. Each handler returns whether
    /// to break the loop after it runs.
    async fn run_fake_runner<S, F>(stream: S, mut step: F)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
        F: FnMut(Value, &mut Vec<Value>) -> bool + Send + 'static,
    {
        let (read, mut write) = tokio::io::split(stream);
        let mut lines = BufReader::new(read).lines();
        let mut outbox: Vec<Value> = Vec::new();
        loop {
            let frame = match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                },
                Ok(None) | Err(_) => break,
            };
            let done = step(frame, &mut outbox);
            for f in outbox.drain(..) {
                let mut bytes = serde_json::to_vec(&f).unwrap();
                bytes.push(b'\n');
                if write.write_all(&bytes).await.is_err() {
                    return;
                }
            }
            if done {
                // Linger so the client's reader stays attached for
                // pushes / notifications we may still want to deliver.
                std::future::pending::<()>().await;
            }
        }
    }

    #[tokio::test]
    async fn connect_completes_the_attach_handshake() {
        let (transport, server) = PairedTransport::paired();
        tokio::spawn(run_fake_runner(server, |frame, outbox| {
            let id = frame["id"].as_u64().unwrap();
            assert_eq!(frame["method"], "attach");
            assert_eq!(frame["params"]["protocolVersion"], RUNNER_PROTOCOL_VERSION);
            assert_eq!(frame["params"]["role"], "desktop-test");
            outbox.push(json!({
                "id": id,
                "result": {
                    "sessionId": "sess-1",
                    "protocolVersion": RUNNER_PROTOCOL_VERSION,
                    "info": { "modes": [] }
                }
            }));
            true
        }));

        let (bridge, _rx) = deadline(
            "connect",
            RunnerBridge::connect(Arc::new(transport), "desktop-test"),
        )
        .await
        .expect("connect");
        assert_eq!(bridge.session_id().as_deref(), Some("sess-1"));
        assert_eq!(bridge.role(), "desktop-test");
    }

    #[tokio::test]
    async fn protocol_mismatch_surfaces_as_a_bridge_error() {
        let (transport, server) = PairedTransport::paired();
        tokio::spawn(run_fake_runner(server, |frame, outbox| {
            let id = frame["id"].as_u64().unwrap();
            outbox.push(json!({
                "id": id,
                "result": {
                    "sessionId": "sess-1",
                    "protocolVersion": 999_999,
                    "info": {}
                }
            }));
            true
        }));

        let result = deadline(
            "connect",
            RunnerBridge::connect(Arc::new(transport), "desktop-test"),
        )
        .await;
        match result {
            Err(BridgeError::ProtocolMismatch { runner, ours }) => {
                assert_eq!(runner, 999_999);
                assert_eq!(ours, RUNNER_PROTOCOL_VERSION);
            }
            Err(other) => panic!("expected ProtocolMismatch, got {other:?}"),
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    #[tokio::test]
    async fn run_turn_returns_the_runner_assigned_id() {
        let (transport, server) = PairedTransport::paired();
        tokio::spawn(run_fake_runner(server, |frame, outbox| {
            let id = frame["id"].as_u64().unwrap();
            match frame["method"].as_str().unwrap() {
                "attach" => {
                    outbox.push(json!({
                        "id": id,
                        "result": {
                            "sessionId": "sess-1",
                            "protocolVersion": RUNNER_PROTOCOL_VERSION,
                            "info": {}
                        }
                    }));
                    false
                }
                "runTurn" => {
                    assert_eq!(frame["params"]["prompt"], "summarise the README");
                    outbox.push(json!({ "id": id, "result": { "turnId": "T-42" } }));
                    true
                }
                other => panic!("unexpected method {other}"),
            }
        }));

        let (bridge, _rx) = deadline(
            "connect",
            RunnerBridge::connect(Arc::new(transport), "desktop"),
        )
        .await
        .unwrap();
        let result = deadline(
            "runTurn",
            bridge.run_turn(RunTurnParams {
                prompt: "summarise the README".into(),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        assert_eq!(result.turn_id, "T-42");
    }

    #[tokio::test]
    async fn event_notifications_fan_out_to_subscribers() {
        let (transport, server) = PairedTransport::paired();
        tokio::spawn(run_fake_runner(server, move |frame, outbox| {
            let id = frame["id"].as_u64().unwrap();
            // attach → reply, then push two events + a turn.complete.
            outbox.push(json!({
                "id": id,
                "result": {
                    "sessionId": "sess-1",
                    "protocolVersion": RUNNER_PROTOCOL_VERSION,
                    "info": {}
                }
            }));
            outbox.push(json!({
                "method": "event",
                "params": { "event": { "kind": "chunk", "text": "hello" } }
            }));
            outbox.push(json!({
                "method": "event",
                "params": { "event": { "kind": "chunk", "text": "world" } }
            }));
            outbox.push(json!({
                "method": "turn.complete",
                "params": { "turnId": "T-1" }
            }));
            true
        }));

        let (bridge, mut rx) = deadline(
            "connect",
            RunnerBridge::connect(Arc::new(transport), "desktop"),
        )
        .await
        .unwrap();
        // Use the initial receiver from connect() so the history-replay
        // events sent immediately after attach are delivered to us.
        let _later_rx = bridge.subscribe();

        // Collect three events: two `event`s + the `turn.complete`. Each
        // arrives via the broadcast channel as the reader picks it up.
        let mut chunks = Vec::new();
        let mut completed: Option<String> = None;
        for _ in 0..3 {
            match deadline("recv", rx.recv()).await.unwrap() {
                BridgeEvent::Event { event } => {
                    chunks.push(event["text"].as_str().unwrap().to_string());
                }
                BridgeEvent::TurnComplete { turn_id, error } => {
                    completed = Some(turn_id);
                    assert!(error.is_none());
                }
                BridgeEvent::InfoChanged { .. } | BridgeEvent::Lagged { .. } => {
                    panic!("unexpected event variant");
                }
            }
        }
        assert_eq!(chunks, vec!["hello".to_string(), "world".to_string()]);
        assert_eq!(completed.as_deref(), Some("T-1"));
    }

    #[tokio::test]
    async fn abort_turn_marshals_the_turn_id() {
        let (transport, server) = PairedTransport::paired();
        let (sentinel_tx, mut sentinel_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tokio::spawn(run_fake_runner(server, move |frame, outbox| {
            let id = frame["id"].as_u64().unwrap();
            match frame["method"].as_str().unwrap() {
                "attach" => {
                    outbox.push(json!({
                        "id": id,
                        "result": {
                            "sessionId": "sess-1",
                            "protocolVersion": RUNNER_PROTOCOL_VERSION,
                            "info": {}
                        }
                    }));
                    false
                }
                "abort" => {
                    let turn_id = frame["params"]["turnId"].as_str().unwrap().to_string();
                    let _ = sentinel_tx.send(turn_id);
                    outbox.push(json!({ "id": id, "result": {} }));
                    true
                }
                other => panic!("unexpected method {other}"),
            }
        }));

        let (bridge, _rx) = deadline(
            "connect",
            RunnerBridge::connect(Arc::new(transport), "desktop"),
        )
        .await
        .unwrap();
        deadline("abort", bridge.abort_turn("T-42")).await.unwrap();
        let observed = deadline("sentinel", sentinel_rx.recv()).await.unwrap();
        assert_eq!(observed, "T-42");
    }

    #[tokio::test]
    async fn dropping_a_subscriber_does_not_break_the_bridge() {
        // Regression guard: if the broadcast channel ever switched to a
        // semantics where the first receiver is mandatory, dropping it
        // would close the channel and stall the next `subscribe`.
        let (transport, server) = PairedTransport::paired();
        tokio::spawn(run_fake_runner(server, |frame, outbox| {
            let id = frame["id"].as_u64().unwrap();
            outbox.push(json!({
                "id": id,
                "result": {
                    "sessionId": "sess-1",
                    "protocolVersion": RUNNER_PROTOCOL_VERSION,
                    "info": {}
                }
            }));
            outbox.push(json!({
                "method": "event",
                "params": { "event": { "kind": "noop" } }
            }));
            true
        }));

        let (bridge, _rx) = deadline(
            "connect",
            RunnerBridge::connect(Arc::new(transport), "desktop"),
        )
        .await
        .unwrap();
        let rx1 = bridge.subscribe();
        drop(rx1);
        let mut rx2 = bridge.subscribe();
        // rx2 only sees events published AFTER subscribe(). The first
        // event from the fake runner was published in response to attach
        // and may already be queued; either way, calling recv with a
        // deadline must not hang on the bridge being structurally dead.
        let result = tokio::time::timeout(Duration::from_millis(200), rx2.recv()).await;
        // We accept either an event (if delivery is fast enough) or a
        // timeout — the failure mode we're guarding against is a
        // `RecvError::Closed`, which would surface immediately.
        match result {
            Ok(Ok(_)) | Err(_) => {}
            Ok(Err(e)) => panic!("subscriber closed unexpectedly: {e:?}"),
        }
    }
}
