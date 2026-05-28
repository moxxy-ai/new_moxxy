//! Integration tests exercising the trait composition in core.
//!
//! The Tauri-aware AppState lives in the parent app crate; here we cover
//! the same composition with an inline state struct that holds the same
//! trait objects, so the contract is exercised without dragging Tauri
//! into the test binary.

use moxxy_desktop_core::desks::{json_store::JsonDeskStore, Desk, DeskId, DeskStore};
use moxxy_desktop_core::sidecar::{mock::MockSidecar, Sidecar, SidecarStatus};
use moxxy_desktop_core::transport::{mock::PairedTransport, RunnerTransport};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone)]
struct State {
    desks: Arc<dyn DeskStore>,
    sidecar: Arc<dyn Sidecar>,
    transport: Arc<dyn RunnerTransport>,
}

#[tokio::test]
async fn capability_traits_compose_through_arc_trait_objects() {
    let tmp = TempDir::new().unwrap();
    let desks: Arc<dyn DeskStore> = Arc::new(JsonDeskStore::at(tmp.path().join("desks.json")));
    let sidecar = Arc::new(MockSidecar::with_status(SidecarStatus::Stopped));
    let (transport, mut server) = PairedTransport::paired();
    let transport: Arc<dyn RunnerTransport> = Arc::new(transport);

    let state = State {
        desks: desks.clone(),
        sidecar: sidecar.clone(),
        transport: transport.clone(),
    };

    sidecar.start().await.unwrap();
    assert_eq!(state.sidecar.status(), SidecarStatus::Running);

    state
        .desks
        .upsert(Desk {
            id: DeskId::new("integration").unwrap(),
            name: "Integration".into(),
            dir: PathBuf::from("/tmp"),
            color: "#818cf8".into(),
            provider: None,
            model: None,
        })
        .await
        .unwrap();
    assert_eq!(state.desks.list().await.unwrap().len(), 1);

    let mut client = state.transport.connect().await.unwrap();
    client.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    server.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");
}

#[tokio::test]
async fn supervisor_restart_policy_pattern() {
    let sc = Arc::new(MockSidecar::new());
    sc.fail_next_start("simulated crash 1");
    let _ = sc.start().await;
    sc.fail_next_start("simulated crash 2");
    let _ = sc.start().await;
    sc.start().await.unwrap();
    assert_eq!(sc.status(), SidecarStatus::Running);
    assert_eq!(sc.start_calls(), 3);
}
