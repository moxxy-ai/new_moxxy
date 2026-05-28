//! moxxy desktop — Tauri shell.
//!
//! All capability traits + impls live in [`moxxy_desktop_core`]; this crate
//! is a thin glue layer that wires them into Tauri. Keeping the heavy
//! deps out of the core means `cargo test -p moxxy-desktop-core` runs in
//! seconds instead of minutes.

#![cfg_attr(feature = "strict", deny(warnings))]
#![deny(unsafe_code)]
#![warn(clippy::pedantic)]
#![allow(
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::module_name_repetitions,
    clippy::must_use_candidate,
    clippy::needless_pass_by_value
)]

pub mod app_state;
pub mod boot;
pub mod commands;

// Re-export the core for downstream Tauri code that wants the traits in
// the same path as before.
pub use moxxy_desktop_core as core;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "moxxy_desktop_lib=info,warn".into()),
        )
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            use tauri::Manager;
            let state = app_state::AppState::production(app.handle())?;
            app.manage(state.clone());
            // Spawn the boot task — sidecar start, wait for runner, attach
            // the bridge, then pump events. Window already shows.
            boot::spawn(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sidecar_status,
            commands::desks_list,
            commands::desks_upsert,
            commands::desks_remove,
            commands::desks_set_active,
            commands::desks_active,
            commands::run_turn,
            commands::abort_turn,
            commands::runner_ready,
            commands::desks_pick_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
