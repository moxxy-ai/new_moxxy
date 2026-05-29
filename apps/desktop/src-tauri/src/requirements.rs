//! Tauri-side requirement detection + install actions.
//!
//! Calls into [`moxxy_desktop_core::requirements`] for the pure logic
//! (path probing, struct shapes) and adds the side effects: spawning a
//! `node --version` to learn the Node version, running install commands
//! when the user clicks Install, opening URLs in the system browser.

use std::process::Stdio;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::process::Command;

use moxxy_desktop_core::requirements::{
    locate_on_path, InstallHint, RequirementCheck, RequirementKind, RequirementsStatus,
};

/// Probe Node and the moxxy CLI. Returns a snapshot the React layer
/// renders into the setup screen.
///
/// Provider configuration is NOT checked here — the runner itself is
/// the authority: once it attaches, the app queries its `SessionInfo`
/// and only then decides whether to render the inline init wizard.
/// Snooping the config files from outside led to false negatives
/// (e.g. when `moxxy init` had landed at `~/moxxy.config.yaml`).
pub async fn detect() -> RequirementsStatus {
    let checks = vec![check_node().await, check_moxxy_cli().await];
    RequirementsStatus::from_checks(checks)
}

async fn check_node() -> RequirementCheck {
    let Some(path) = locate_on_path("node") else {
        return RequirementCheck {
            kind: RequirementKind::Node,
            satisfied: false,
            detail: Some("node not found on PATH".into()),
            install: Some(InstallHint::OpenUrl {
                url: "https://nodejs.org/en/download".into(),
                label: "Install Node.js…".into(),
            }),
        };
    };

    // Fast version probe with a short timeout — a hung node child
    // shouldn't block app startup. The node version doesn't gate
    // satisfied=true; it's purely informational.
    let version = run_with_timeout(&path, &["--version"], 3_000).await;
    RequirementCheck {
        kind: RequirementKind::Node,
        satisfied: true,
        detail: Some(format!(
            "{} ({})",
            version
                .as_deref()
                .unwrap_or("unknown")
                .trim(),
            path.display()
        )),
        install: None,
    }
}

async fn check_moxxy_cli() -> RequirementCheck {
    // Three places we might find the CLI, tried in order:
    //   1. MOXXY_CLI_ENTRY explicit override
    //   2. monorepo dev location (`packages/cli/dist/bin.js`)
    //   3. globally-installed `moxxy` on PATH
    if let Ok(path) = std::env::var("MOXXY_CLI_ENTRY") {
        if std::path::Path::new(&path).is_file() {
            return ok_cli(format!("{path} (env override)"));
        }
    }
    if let Some(monorepo) = find_monorepo_cli() {
        return ok_cli(format!("{} (dev tree)", monorepo.display()));
    }
    if let Some(bin) = locate_on_path("moxxy") {
        return ok_cli(format!("{} (global install)", bin.display()));
    }
    RequirementCheck {
        kind: RequirementKind::MoxxyCli,
        satisfied: false,
        detail: Some("moxxy not found on PATH and no dev tree detected".into()),
        install: Some(InstallHint::Command {
            program: "npm".into(),
            args: vec!["install".into(), "-g".into(), "@moxxy/cli".into()],
            label: "Install moxxy CLI".into(),
        }),
    }
}

fn ok_cli(detail: String) -> RequirementCheck {
    RequirementCheck {
        kind: RequirementKind::MoxxyCli,
        satisfied: true,
        detail: Some(detail),
        install: None,
    }
}

fn find_monorepo_cli() -> Option<std::path::PathBuf> {
    let mut p = std::env::current_dir().ok()?;
    loop {
        let candidate = p.join("packages").join("cli").join("dist").join("bin.js");
        if candidate.is_file() {
            return Some(candidate);
        }
        p = p.parent()?.to_path_buf();
    }
}

// (check_provider removed — the runner is the authority for provider
// state. The desktop reads its info via the bridge after attach and
// shows an inline init wizard when no active provider is configured.)

async fn run_with_timeout(
    program: &std::path::Path,
    args: &[&str],
    timeout_ms: u64,
) -> Option<String> {
    let fut = async {
        let out = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), fut)
        .await
        .ok()
        .flatten()
}

/// Drive an [`InstallHint::Command`] to completion, streaming progress
/// events to the webview so the wizard can show "Installing…" then a
/// final pass/fail. Each line of stdout/stderr is forwarded as a
/// `requirements.install.progress` payload; the final result fires as
/// `requirements.install.done`.
pub async fn run_install_command<R: Runtime>(
    app: &AppHandle<R>,
    program: String,
    args: Vec<String>,
) -> Result<i32, String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let _ = app.emit(
        "requirements.install.progress",
        format!("$ {} {}", program, args.join(" ")),
    );

    let mut child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn {program}: {e}"))?;

    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");

    let app_out = app.clone();
    let stdout_pump = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit("requirements.install.progress", line);
        }
    });
    let app_err = app.clone();
    let stderr_pump = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("requirements.install.progress", line);
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("wait {program}: {e}"))?;
    let _ = stdout_pump.await;
    let _ = stderr_pump.await;

    let code = status.code().unwrap_or(-1);
    let _ = app.emit(
        "requirements.install.done",
        serde_json::json!({ "code": code }),
    );
    Ok(code)
}
