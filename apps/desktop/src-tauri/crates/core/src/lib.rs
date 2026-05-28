//! moxxy-desktop-core — capability traits + implementations, no Tauri deps.
//!
//! The Tauri shell (`moxxy-desktop` in the parent crate) is a thin glue
//! layer over this. Splitting them keeps `cargo test` fast: the entire
//! Tauri / wry / webview2 dep tree is only built when packaging the app,
//! never for the unit suites.

#![deny(unsafe_code)]
#![warn(clippy::pedantic)]
#![allow(
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::module_name_repetitions,
    clippy::must_use_candidate,
    clippy::needless_pass_by_value
)]

pub mod desks;
pub mod error;
pub mod jsonrpc;
pub mod sidecar;
pub mod transport;
