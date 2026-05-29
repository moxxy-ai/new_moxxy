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
pub mod requirements;
pub mod tray;

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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            use tauri::Manager;
            let state = app_state::AppState::production(app.handle())?;
            app.manage(state.clone());
            // Spawn the boot task — sidecar start, wait for runner, attach
            // the bridge, then pump events. Window already shows.
            boot::spawn(app.handle().clone(), state);
            // Tray + global hotkey. Failures are logged but never crash
            // the app — a desktop without a tray is still usable.
            match tray::install(app.handle()) {
                Ok(tray) => {
                    app.manage(tray);
                }
                Err(e) => tracing::warn!(error = %e, "install tray"),
            }
            tray::register_global_hotkey(app.handle());
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
            commands::runner_info,
            commands::runner_set_provider,
            commands::runner_set_mode,
            commands::transcribe,
            commands::desks_pick_folder,
            commands::open_session_window,
            commands::close_session_window,
            commands::schedules_list,
            commands::schedules_create,
            commands::schedules_update,
            commands::schedules_delete,
            commands::schedules_set_enabled,
            commands::schedules_validate_cron,
            commands::requirements_check,
            commands::requirements_install,
            commands::settings_providers_list,
            commands::settings_set_api_key,
            commands::settings_skills_list,
            commands::settings_skill_read,
            commands::settings_skill_write,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Cmd+Q / Alt+F4 / OS shutdown all funnel through ExitRequested.
            // We block exit just long enough to kill the runner pool so no
            // stray `node moxxy serve` child is left behind.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                if let Some(state) = app.try_state::<app_state::AppState>() {
                    let state = state.inner().clone();
                    // Block on the existing tokio runtime; ExitRequested
                    // already runs after the window loop has stopped, so a
                    // synchronous wait here is safe and bounded.
                    tauri::async_runtime::block_on(async move {
                        state.shutdown().await;
                    });
                }
            }
        });
}
