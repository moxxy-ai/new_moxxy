//! `desks.json` on disk. Atomic writes + per-store mutex.

use async_trait::async_trait;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::sync::Mutex;

use super::{Desk, DeskDoc, DeskId, DeskStore};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct JsonDeskStore {
    path: PathBuf,
    lock: std::sync::Arc<Mutex<()>>,
}

impl JsonDeskStore {
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: std::sync::Arc::new(Mutex::new(())),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    async fn load(&self) -> AppResult<DeskDoc> {
        match fs::read(&self.path).await {
            Ok(bytes) => {
                if bytes.is_empty() {
                    return Ok(DeskDoc::default());
                }
                let mut doc: DeskDoc = serde_json::from_slice(&bytes)?;
                self.migrate_in_place(&mut doc);
                Ok(doc)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(DeskDoc::default()),
            Err(e) => Err(AppError::Io(e)),
        }
    }

    async fn save(&self, doc: &DeskDoc) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(doc)?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, &bytes).await?;
        fs::rename(&tmp, &self.path).await?;
        Ok(())
    }

    #[allow(clippy::unused_self)]
    fn migrate_in_place(&self, doc: &mut DeskDoc) {
        if doc.version > DeskDoc::CURRENT_VERSION {
            tracing::warn!(
                "desks.json is from a newer version ({}); some fields may be ignored",
                doc.version,
            );
        }
        doc.version = DeskDoc::CURRENT_VERSION;
    }
}

#[async_trait]
impl DeskStore for JsonDeskStore {
    async fn list(&self) -> AppResult<Vec<Desk>> {
        let _guard = self.lock.lock().await;
        Ok(self.load().await?.desks)
    }

    async fn upsert(&self, desk: Desk) -> AppResult<()> {
        let _guard = self.lock.lock().await;
        let mut doc = self.load().await?;
        if let Some(slot) = doc.desks.iter_mut().find(|d| d.id == desk.id) {
            *slot = desk;
        } else {
            doc.desks.push(desk);
        }
        self.save(&doc).await
    }

    async fn remove(&self, id: &DeskId) -> AppResult<()> {
        let _guard = self.lock.lock().await;
        let mut doc = self.load().await?;
        let before = doc.desks.len();
        doc.desks.retain(|d| d.id != *id);
        if doc.desks.len() == before {
            return Err(AppError::DeskNotFound(id.to_string()));
        }
        if doc.active.as_ref() == Some(id) {
            doc.active = doc.desks.first().map(|d| d.id.clone());
        }
        self.save(&doc).await
    }

    async fn set_active(&self, id: &DeskId) -> AppResult<()> {
        let _guard = self.lock.lock().await;
        let mut doc = self.load().await?;
        if !doc.desks.iter().any(|d| d.id == *id) {
            return Err(AppError::DeskNotFound(id.to_string()));
        }
        doc.active = Some(id.clone());
        self.save(&doc).await
    }

    async fn active(&self) -> AppResult<Option<DeskId>> {
        let _guard = self.lock.lock().await;
        Ok(self.load().await?.active)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn store(tmp: &TempDir) -> JsonDeskStore {
        JsonDeskStore::at(tmp.path().join("desks.json"))
    }

    fn desk(id: &str, name: &str) -> Desk {
        Desk {
            id: DeskId::new(id).unwrap(),
            name: name.into(),
            dir: PathBuf::from("/tmp"),
            color: "#818cf8".into(),
            provider: None,
            model: None,
        }
    }

    #[tokio::test]
    async fn list_returns_empty_for_a_missing_file() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        assert!(s.list().await.unwrap().is_empty());
        assert!(s.active().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn upsert_inserts_then_updates() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        s.upsert(desk("personal", "Personal")).await.unwrap();
        s.upsert(desk("personal", "Renamed")).await.unwrap();
        let list = s.list().await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Renamed");
    }

    #[tokio::test]
    async fn remove_unknown_id_is_an_error() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let id = DeskId::new("ghost").unwrap();
        let err = s.remove(&id).await.unwrap_err();
        assert!(matches!(err, AppError::DeskNotFound(_)));
    }

    #[tokio::test]
    async fn remove_promotes_active_to_another_desk() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        s.upsert(desk("personal", "Personal")).await.unwrap();
        s.upsert(desk("work", "Work")).await.unwrap();
        s.set_active(&DeskId::new("personal").unwrap())
            .await
            .unwrap();
        s.remove(&DeskId::new("personal").unwrap()).await.unwrap();
        assert_eq!(
            s.active().await.unwrap().unwrap().as_str(),
            "work",
        );
    }

    #[tokio::test]
    async fn remove_clears_active_when_no_desks_remain() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        s.upsert(desk("personal", "Personal")).await.unwrap();
        s.set_active(&DeskId::new("personal").unwrap())
            .await
            .unwrap();
        s.remove(&DeskId::new("personal").unwrap()).await.unwrap();
        assert!(s.active().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn set_active_rejects_unknown_ids() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        s.upsert(desk("personal", "Personal")).await.unwrap();
        let err = s
            .set_active(&DeskId::new("nope").unwrap())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::DeskNotFound(_)));
    }

    #[tokio::test]
    async fn writes_go_through_a_tmp_file_atomically() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        s.upsert(desk("personal", "Personal")).await.unwrap();
        let tmp_path = tmp.path().join("desks.json.tmp");
        assert!(!tmp_path.exists());
        let canonical = tmp.path().join("desks.json");
        assert!(canonical.exists());
    }

    #[tokio::test]
    async fn parent_directory_is_created_on_demand() {
        let tmp = TempDir::new().unwrap();
        let nested = tmp.path().join("a/b/c/desks.json");
        let s = JsonDeskStore::at(&nested);
        s.upsert(desk("personal", "Personal")).await.unwrap();
        assert!(nested.exists());
    }

    #[tokio::test]
    async fn migration_pins_version_on_load() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("desks.json");
        std::fs::write(
            &path,
            r#"{ "version": 999, "active": null, "desks": [] }"#,
        )
        .unwrap();
        let s = JsonDeskStore::at(&path);
        s.upsert(desk("p", "P")).await.unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["version"], 1);
    }

    #[tokio::test]
    async fn concurrent_upserts_do_not_corrupt_the_file() {
        let tmp = TempDir::new().unwrap();
        let s = store(&tmp);
        let mut handles = Vec::new();
        for i in 0..32 {
            let s2 = s.clone();
            handles.push(tokio::spawn(async move {
                s2.upsert(desk(&format!("d{i}"), &format!("Desk {i}"))).await
            }));
        }
        for h in handles {
            h.await.unwrap().unwrap();
        }
        let list = s.list().await.unwrap();
        assert_eq!(list.len(), 32);
        let fresh = JsonDeskStore::at(s.path());
        assert_eq!(fresh.list().await.unwrap().len(), 32);
    }
}

#[cfg(test)]
mod proptests {
    use super::*;
    use proptest::prelude::*;
    use tempfile::TempDir;

    fn arb_id() -> impl Strategy<Value = DeskId> {
        "[a-zA-Z0-9_-]{1,32}".prop_filter_map("invalid", |s| DeskId::new(s).ok())
    }

    fn arb_desk() -> impl Strategy<Value = Desk> {
        (
            arb_id(),
            "[\\PC]{1,32}",
            "[/a-zA-Z0-9_-]{1,64}",
            "#[0-9a-fA-F]{6}",
        )
            .prop_map(|(id, name, dir, color)| Desk {
                id,
                name,
                dir: PathBuf::from(dir),
                color,
                provider: None,
                model: None,
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 64,
            ..ProptestConfig::default()
        })]

        #[test]
        fn upsert_then_list_round_trips(desks in proptest::collection::vec(arb_desk(), 0..16)) {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let tmp = TempDir::new().unwrap();
                let store = JsonDeskStore::at(tmp.path().join("desks.json"));

                let mut expected: Vec<Desk> = Vec::new();
                for d in &desks {
                    store.upsert(d.clone()).await.unwrap();
                    if let Some(slot) = expected.iter_mut().find(|e| e.id == d.id) {
                        *slot = d.clone();
                    } else {
                        expected.push(d.clone());
                    }
                }

                let actual = store.list().await.unwrap();
                prop_assert_eq!(actual, expected);
                Ok::<(), TestCaseError>(())
            })?;
        }
    }
}
