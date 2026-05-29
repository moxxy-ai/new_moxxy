//! Detect what's needed for the moxxy runner to boot.
//!
//! The desktop app aims to be self-contained: a user downloads it, hits
//! Launch, and the app guides them through any missing system bits
//! (Node.js, the moxxy CLI, a provider key). This module owns the
//! detection side of that story — running checks, reporting status,
//! exposing knobs the UI uses to decide what step to render.
//!
//! The Tauri command layer (`src-tauri/src/commands.rs`) wraps these
//! checks; the install side is in `src-tauri/src/installer.rs` so the
//! pure-Rust core stays free of process-spawning side effects beyond
//! the trivial `which`-like probes.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Which underlying system requirement we're asking about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequirementKind {
    /// Node.js runtime on PATH. Needed to spawn the moxxy CLI.
    Node,
    /// The bundled `moxxy` CLI binary — installed globally via npm or
    /// shipped inside the app's resources.
    MoxxyCli,
    /// Deprecated — kept for serde compatibility with any older
    /// payload still in flight. The desktop no longer reports on
    /// provider configuration via the requirements channel; the
    /// runner is queried directly via the bridge instead.
    ProviderKey,
}

impl RequirementKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Node => "Node.js",
            Self::MoxxyCli => "moxxy CLI",
            Self::ProviderKey => "Provider key",
        }
    }
}

/// One requirement check's result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequirementCheck {
    pub kind: RequirementKind,
    pub satisfied: bool,
    /// Free-form detail shown under the requirement (version string,
    /// install path, missing reason). Renders as mono dim text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// If `satisfied == false`, the path the install action will take.
    /// `None` = the user has to do it manually (e.g. install Node from
    /// nodejs.org).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install: Option<InstallHint>,
}

/// What clicking "Install" on this requirement does. The Tauri command
/// layer interprets these and either runs the command itself or opens
/// the URL in the system browser.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum InstallHint {
    /// Run a shell command on the user's machine. Used for things we
    /// can confidently automate (e.g. `npm install -g @moxxy/cli`).
    Command {
        program: String,
        args: Vec<String>,
        /// Short copy shown on the install button + in the progress
        /// status (e.g. "Installing moxxy CLI…").
        label: String,
    },
    /// Open this URL in the system browser. Used for things only the
    /// user's package manager can do well (Node.js, ffmpeg).
    OpenUrl {
        url: String,
        label: String,
    },
}

/// Aggregated status of every requirement. The desktop hides the main
/// chat surface and shows a setup screen instead while `all_met` is
/// false.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequirementsStatus {
    pub all_met: bool,
    pub checks: Vec<RequirementCheck>,
}

impl RequirementsStatus {
    pub fn from_checks(checks: Vec<RequirementCheck>) -> Self {
        let all_met = checks.iter().all(|c| c.satisfied);
        Self { all_met, checks }
    }
}

/// Locate an executable on `PATH`, returning the absolute path if found.
///
/// We don't shell out to `which` / `where` — both have edge cases on
/// non-interactive shells. We walk the `PATH` env var ourselves so the
/// behaviour is identical across platforms.
pub fn locate_on_path(program: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .ok()
            .map(|raw| {
                raw.split(';')
                    .filter(|e| !e.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| vec![".COM".into(), ".EXE".into(), ".BAT".into()])
    } else {
        vec![String::new()]
    };

    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requirement_kind_labels_are_user_facing() {
        assert_eq!(RequirementKind::Node.label(), "Node.js");
        assert_eq!(RequirementKind::MoxxyCli.label(), "moxxy CLI");
        assert_eq!(RequirementKind::ProviderKey.label(), "Provider key");
    }

    #[test]
    fn from_checks_marks_all_met_when_every_check_passes() {
        let s = RequirementsStatus::from_checks(vec![
            RequirementCheck {
                kind: RequirementKind::Node,
                satisfied: true,
                detail: Some("v22.15.0".into()),
                install: None,
            },
            RequirementCheck {
                kind: RequirementKind::MoxxyCli,
                satisfied: true,
                detail: None,
                install: None,
            },
        ]);
        assert!(s.all_met);
    }

    #[test]
    fn from_checks_marks_not_met_when_any_check_fails() {
        let s = RequirementsStatus::from_checks(vec![
            RequirementCheck {
                kind: RequirementKind::Node,
                satisfied: false,
                detail: Some("not found".into()),
                install: Some(InstallHint::OpenUrl {
                    url: "https://nodejs.org/".into(),
                    label: "Install Node.js".into(),
                }),
            },
            RequirementCheck {
                kind: RequirementKind::MoxxyCli,
                satisfied: true,
                detail: None,
                install: None,
            },
        ]);
        assert!(!s.all_met);
    }

    #[test]
    fn install_hints_serialise_with_a_kind_tag() {
        let cmd = InstallHint::Command {
            program: "npm".into(),
            args: vec!["install".into(), "-g".into(), "@moxxy/cli".into()],
            label: "Install moxxy CLI".into(),
        };
        let s = serde_json::to_value(&cmd).unwrap();
        assert_eq!(s["kind"], "command");
        assert_eq!(s["program"], "npm");

        let url = InstallHint::OpenUrl {
            url: "https://nodejs.org/".into(),
            label: "Install Node.js".into(),
        };
        let s = serde_json::to_value(&url).unwrap();
        assert_eq!(s["kind"], "open-url");
        assert_eq!(s["url"], "https://nodejs.org/");
    }

    #[test]
    fn locate_on_path_finds_an_existing_binary() {
        // `sh` is virtually guaranteed on unix; on Windows test runs
        // we accept either `cmd.exe` or `powershell.exe`.
        #[cfg(unix)]
        {
            let p = locate_on_path("sh");
            assert!(p.is_some(), "expected /bin/sh or similar to be located");
        }
        #[cfg(windows)]
        {
            let cmd = locate_on_path("cmd").or_else(|| locate_on_path("powershell"));
            assert!(cmd.is_some(), "expected cmd or powershell to be located");
        }
    }

    #[test]
    fn locate_on_path_returns_none_for_a_missing_binary() {
        assert!(locate_on_path("__definitely_not_a_real_binary_98765__").is_none());
    }

    #[test]
    fn requirement_check_round_trips_through_json() {
        let c = RequirementCheck {
            kind: RequirementKind::MoxxyCli,
            satisfied: false,
            detail: Some("not on PATH".into()),
            install: Some(InstallHint::Command {
                program: "npm".into(),
                args: vec!["install".into(), "-g".into(), "@moxxy/cli".into()],
                label: "Install moxxy CLI".into(),
            }),
        };
        let s = serde_json::to_string(&c).unwrap();
        let parsed: RequirementCheck = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.kind, RequirementKind::MoxxyCli);
        assert!(!parsed.satisfied);
    }
}
