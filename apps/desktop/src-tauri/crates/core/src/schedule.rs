//! Schedule store — mirror of `packages/plugin-scheduler/src/store.ts`.
//!
//! The desktop reads + writes `~/.moxxy/schedules.json` directly so the
//! scheduler panel works without a runner roundtrip on every render.
//! The primary runner's `SchedulerPoller` reads the same file at its
//! tick interval, so a desktop-driven create lands on disk and the
//! poller picks it up at the next sweep — eventual consistency, but
//! good enough for a 30-second tick.
//!
//! The schema is mirrored, not shared. The TS side is authoritative;
//! a `core::tests::schema_compat` test in the wider integration suite
//! asserts representative round-trips.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Stable id. The TS side uses ULID; we use UUIDv4 + a `ulid-`
/// prefix when ULID isn't available. The TS scheduler treats `id` as
/// opaque so its shape doesn't matter beyond uniqueness.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ScheduleId(String);

impl ScheduleId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// Construct from a value already known to be a valid id (loaded
    /// from disk, supplied by the agent's tool call, …).
    pub fn from_raw(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ScheduleId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ScheduleId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Source of a schedule — `manual` for user-created, `skill` for
/// schedules synthesized off a skill's frontmatter, `workflow` for a
/// workflow-pinned trigger. The desktop GUI only ever creates `manual`
/// rows; the others appear read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleSource {
    Manual,
    Skill,
    Workflow,
}

impl Default for ScheduleSource {
    fn default() -> Self {
        Self::Manual
    }
}

/// Outcome of the last fire of this schedule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleResult {
    Ok,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleEntry {
    pub id: ScheduleId,
    /// Slug-like display name (`[a-z0-9][a-z0-9-]*`, ≤120 chars).
    pub name: String,
    /// What the agent should do when this fires.
    pub prompt: String,
    /// POSIX 5-field cron expression. Mutually-optional with `run_at`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    /// Epoch-ms timestamp for one-shot schedules.
    #[serde(rename = "runAt", default, skip_serializing_if = "Option::is_none")]
    pub run_at: Option<i64>,
    /// IANA timezone for cron interpretation. None = system local.
    #[serde(rename = "timeZone", default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    /// Soft hint for delivery target (`"inbox"`, `"telegram"`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Per-schedule model override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "lastRunAt", default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    #[serde(rename = "lastResult", default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<ScheduleResult>,
    #[serde(rename = "lastError", default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub source: ScheduleSource,
    #[serde(rename = "skillName", default, skip_serializing_if = "Option::is_none")]
    pub skill_name: Option<String>,
    #[serde(rename = "workflowName", default, skip_serializing_if = "Option::is_none")]
    pub workflow_name: Option<String>,
}

fn default_enabled() -> bool {
    true
}

/// Persisted document shape. Mirrors `fileSchema` in the TS store —
/// the JS poller reads this exact format off disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleDoc {
    pub version: u32,
    pub schedules: Vec<ScheduleEntry>,
}

impl Default for ScheduleDoc {
    fn default() -> Self {
        Self {
            version: Self::CURRENT_VERSION,
            schedules: Vec::new(),
        }
    }
}

impl ScheduleDoc {
    pub const CURRENT_VERSION: u32 = 1;
}

/// Input for a new schedule. Subset of [`ScheduleEntry`] without
/// server-assigned fields. Mirrors `create()` in the TS store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSchedule {
    pub name: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    #[serde(rename = "runAt", default, skip_serializing_if = "Option::is_none")]
    pub run_at: Option<i64>,
    #[serde(rename = "timeZone", default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[async_trait]
pub trait ScheduleStore: Send + Sync + 'static {
    async fn list(&self) -> AppResult<Vec<ScheduleEntry>>;
    async fn create(&self, input: NewSchedule) -> AppResult<ScheduleEntry>;
    /// Partial update — only `cron`, `run_at`, `prompt`, `name`,
    /// `channel`, `model`, `enabled`, `time_zone` are honoured. Other
    /// fields stay as they were on disk.
    async fn update(&self, id: &ScheduleId, patch: SchedulePatch) -> AppResult<ScheduleEntry>;
    async fn delete(&self, id: &ScheduleId) -> AppResult<()>;
    async fn set_enabled(&self, id: &ScheduleId, enabled: bool) -> AppResult<ScheduleEntry>;
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct SchedulePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<Option<String>>,
    #[serde(rename = "runAt", default, skip_serializing_if = "Option::is_none")]
    pub run_at: Option<Option<i64>>,
    #[serde(rename = "timeZone", default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct JsonScheduleStore {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl JsonScheduleStore {
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    async fn load(&self) -> AppResult<ScheduleDoc> {
        match fs::read(&self.path).await {
            Ok(bytes) if bytes.is_empty() => Ok(ScheduleDoc::default()),
            Ok(bytes) => {
                let mut doc: ScheduleDoc = serde_json::from_slice(&bytes)?;
                doc.version = ScheduleDoc::CURRENT_VERSION;
                Ok(doc)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ScheduleDoc::default()),
            Err(e) => Err(AppError::Io(e)),
        }
    }

    async fn save(&self, doc: &ScheduleDoc) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(doc)?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, &bytes).await?;
        fs::rename(&tmp, &self.path).await?;
        Ok(())
    }
}

#[async_trait]
impl ScheduleStore for JsonScheduleStore {
    async fn list(&self) -> AppResult<Vec<ScheduleEntry>> {
        let _g = self.lock.lock().await;
        Ok(self.load().await?.schedules)
    }

    async fn create(&self, input: NewSchedule) -> AppResult<ScheduleEntry> {
        if input.cron.is_none() && input.run_at.is_none() {
            return Err(AppError::Protocol(
                "schedule needs either `cron` or `runAt`".into(),
            ));
        }
        let _g = self.lock.lock().await;
        let mut doc = self.load().await?;
        let entry = ScheduleEntry {
            id: ScheduleId::new(),
            name: input.name,
            prompt: input.prompt,
            cron: input.cron,
            run_at: input.run_at,
            time_zone: input.time_zone,
            channel: input.channel,
            model: input.model,
            enabled: true,
            created_at: now_ms(),
            last_run_at: None,
            last_result: None,
            last_error: None,
            source: ScheduleSource::Manual,
            skill_name: None,
            workflow_name: None,
        };
        doc.schedules.push(entry.clone());
        self.save(&doc).await?;
        Ok(entry)
    }

    async fn update(
        &self,
        id: &ScheduleId,
        patch: SchedulePatch,
    ) -> AppResult<ScheduleEntry> {
        let _g = self.lock.lock().await;
        let mut doc = self.load().await?;
        let slot = doc
            .schedules
            .iter_mut()
            .find(|s| s.id == *id)
            .ok_or_else(|| AppError::DeskNotFound(format!("schedule {id}")))?;
        if let Some(name) = patch.name {
            slot.name = name;
        }
        if let Some(prompt) = patch.prompt {
            slot.prompt = prompt;
        }
        if let Some(cron) = patch.cron {
            slot.cron = cron;
        }
        if let Some(run_at) = patch.run_at {
            slot.run_at = run_at;
        }
        if let Some(tz) = patch.time_zone {
            slot.time_zone = tz;
        }
        if let Some(channel) = patch.channel {
            slot.channel = channel;
        }
        if let Some(model) = patch.model {
            slot.model = model;
        }
        if let Some(enabled) = patch.enabled {
            slot.enabled = enabled;
        }
        if slot.cron.is_none() && slot.run_at.is_none() {
            return Err(AppError::Protocol(
                "schedule needs either `cron` or `runAt`".into(),
            ));
        }
        let updated = slot.clone();
        self.save(&doc).await?;
        Ok(updated)
    }

    async fn delete(&self, id: &ScheduleId) -> AppResult<()> {
        let _g = self.lock.lock().await;
        let mut doc = self.load().await?;
        let before = doc.schedules.len();
        doc.schedules.retain(|s| s.id != *id);
        if doc.schedules.len() == before {
            return Err(AppError::DeskNotFound(format!("schedule {id}")));
        }
        self.save(&doc).await
    }

    async fn set_enabled(
        &self,
        id: &ScheduleId,
        enabled: bool,
    ) -> AppResult<ScheduleEntry> {
        self.update(
            id,
            SchedulePatch {
                enabled: Some(enabled),
                ..Default::default()
            },
        )
        .await
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| {
            let m = d.as_millis();
            i64::try_from(m).unwrap_or(i64::MAX)
        })
        .unwrap_or(0)
}

/// Cheap structural validator for POSIX 5-field cron. Stays in lockstep
/// with the runner's authoritative `isValidCron` for the
/// most common shapes. The full validator lives JS-side; this one is
/// just enough to give a snappy UX in the form before the runner round-
/// trips the create.
pub fn is_basic_valid_cron(expr: &str) -> bool {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return false;
    }
    parts.iter().all(|p| is_cron_field(p))
}

fn is_cron_field(field: &str) -> bool {
    if field.is_empty() {
        return false;
    }
    for chunk in field.split(',') {
        let (range, step) = match chunk.split_once('/') {
            Some((r, s)) => (r, Some(s)),
            None => (chunk, None),
        };
        let range_ok = if range == "*" {
            true
        } else if let Some((lo, hi)) = range.split_once('-') {
            lo.chars().all(|c| c.is_ascii_digit())
                && hi.chars().all(|c| c.is_ascii_digit())
                && !lo.is_empty()
                && !hi.is_empty()
        } else {
            range.chars().all(|c| c.is_ascii_digit())
        };
        if !range_ok {
            return false;
        }
        if let Some(step) = step {
            if step.is_empty() || !step.chars().all(|c| c.is_ascii_digit()) {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store(tmp: &TempDir) -> JsonScheduleStore {
        JsonScheduleStore::at(tmp.path().join("schedules.json"))
    }

    fn cron_input(name: &str, prompt: &str, cron: &str) -> NewSchedule {
        NewSchedule {
            name: name.into(),
            prompt: prompt.into(),
            cron: Some(cron.into()),
            run_at: None,
            time_zone: None,
            channel: None,
            model: None,
        }
    }

    #[tokio::test]
    async fn list_returns_empty_for_a_missing_file() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        assert!(s.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn create_persists_and_assigns_defaults() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let entry = s.create(cron_input("daily", "log heartbeat", "0 9 * * *")).await.unwrap();
        assert_eq!(entry.name, "daily");
        assert!(entry.enabled);
        assert_eq!(entry.source, ScheduleSource::Manual);
        assert!(entry.created_at > 0);
        let list = s.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, entry.id);
    }

    #[tokio::test]
    async fn create_requires_cron_or_run_at() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let res = s
            .create(NewSchedule {
                name: "nope".into(),
                prompt: "x".into(),
                cron: None,
                run_at: None,
                time_zone: None,
                channel: None,
                model: None,
            })
            .await;
        assert!(matches!(res, Err(AppError::Protocol(_))));
    }

    #[tokio::test]
    async fn update_patches_existing_entry() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let entry = s
            .create(cron_input("daily", "log heartbeat", "0 9 * * *"))
            .await
            .unwrap();
        let updated = s
            .update(
                &entry.id,
                SchedulePatch {
                    prompt: Some("updated".into()),
                    cron: Some(Some("0 10 * * *".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.prompt, "updated");
        assert_eq!(updated.cron.as_deref(), Some("0 10 * * *"));
    }

    #[tokio::test]
    async fn update_rejects_unknown_id() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let res = s
            .update(&ScheduleId::new(), SchedulePatch::default())
            .await;
        assert!(matches!(res, Err(AppError::DeskNotFound(_))));
    }

    #[tokio::test]
    async fn update_to_remove_cron_without_run_at_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let entry = s
            .create(cron_input("once", "x", "* * * * *"))
            .await
            .unwrap();
        let res = s
            .update(
                &entry.id,
                SchedulePatch {
                    cron: Some(None),
                    ..Default::default()
                },
            )
            .await;
        assert!(matches!(res, Err(AppError::Protocol(_))));
    }

    #[tokio::test]
    async fn delete_removes_and_persists() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let entry = s
            .create(cron_input("a", "p", "* * * * *"))
            .await
            .unwrap();
        s.delete(&entry.id).await.unwrap();
        assert!(s.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_rejects_unknown_id() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let res = s.delete(&ScheduleId::new()).await;
        assert!(matches!(res, Err(AppError::DeskNotFound(_))));
    }

    #[tokio::test]
    async fn set_enabled_toggles() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let entry = s
            .create(cron_input("a", "p", "* * * * *"))
            .await
            .unwrap();
        let off = s.set_enabled(&entry.id, false).await.unwrap();
        assert!(!off.enabled);
        let on = s.set_enabled(&entry.id, true).await.unwrap();
        assert!(on.enabled);
    }

    #[tokio::test]
    async fn writes_go_through_a_tmp_file_atomically() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        s.create(cron_input("a", "p", "* * * * *")).await.unwrap();
        let tmp_path = tmp.path().join("schedules.json.tmp");
        assert!(!tmp_path.exists());
        let canonical = tmp.path().join("schedules.json");
        assert!(canonical.exists());
    }

    #[tokio::test]
    async fn round_trip_with_real_writes_preserves_optional_fields() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let entry = s
            .create(NewSchedule {
                name: "complex".into(),
                prompt: "do the thing".into(),
                cron: Some("0 9 * * 1-5".into()),
                run_at: None,
                time_zone: Some("Europe/Warsaw".into()),
                channel: Some("inbox".into()),
                model: Some("anthropic/claude-opus-4-7".into()),
            })
            .await
            .unwrap();
        let fresh = JsonScheduleStore::at(s.path());
        let list = fresh.list().await.unwrap();
        assert_eq!(list.len(), 1);
        let loaded = &list[0];
        assert_eq!(loaded.id, entry.id);
        assert_eq!(loaded.time_zone.as_deref(), Some("Europe/Warsaw"));
        assert_eq!(loaded.channel.as_deref(), Some("inbox"));
        assert_eq!(loaded.model.as_deref(), Some("anthropic/claude-opus-4-7"));
    }

    // ---- cron validator ----------------------------------------------------

    #[test]
    fn cron_validator_accepts_common_shapes() {
        for ok in [
            "* * * * *",
            "0 9 * * *",
            "*/5 * * * *",
            "0 0 * * 0",
            "0 9 * * 1-5",
            "0,15,30,45 * * * *",
            "0-30/5 * * * *",
        ] {
            assert!(is_basic_valid_cron(ok), "expected valid: {ok:?}");
        }
    }

    #[test]
    fn cron_validator_rejects_bad_shapes() {
        for bad in [
            "",
            "* * * *",          // 4 fields
            "* * * * * *",      // 6 fields
            "abc * * * *",
            "* * * * a",
            "0/ * * * *",
            "0--5 * * * *",
        ] {
            assert!(!is_basic_valid_cron(bad), "expected invalid: {bad:?}");
        }
    }
}
