use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rivetos::{EnvLookup, HttpExchange, HttpReply, MapEnv};

pub fn den_env() -> Arc<dyn EnvLookup> {
    Arc::new(MapEnv::from_pairs(&[
        ("RIVETOS_CAPTURE_TRANSPORT", "den"),
        ("RIVET_DEN_URL", "https://127.0.0.1:5174"),
    ]))
}

pub fn fixed_clock() -> Arc<dyn Fn() -> String + Send + Sync> {
    Arc::new(|| "2026-10-10T00:00:00.000Z".to_string())
}

pub fn ok_exchange(bodies: Arc<Mutex<Vec<String>>>) -> HttpExchange {
    Arc::new(move |body: &str| {
        let inserted = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value.get("messages")?.as_array().map(|items| items.len()))
            .unwrap_or(0);
        bodies.lock().unwrap().push(body.to_string());
        Ok(HttpReply {
            status: 200,
            body: format!(
                r#"{{"ok":true,"conversation_id":"conv-1","inserted":{inserted},"skipped":0}}"#
            ),
        })
    })
}

pub struct DenHarness {
    pub dir: tempfile::TempDir,
    pub bodies: Arc<Mutex<Vec<String>>>,
    pub env: Arc<dyn EnvLookup>,
    pub exchange: HttpExchange,
}

impl DenHarness {
    pub fn new() -> Self {
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let exchange = ok_exchange(bodies.clone());
        Self {
            dir: tempfile::tempdir().unwrap(),
            bodies,
            env: den_env(),
            exchange,
        }
    }

    pub fn spool(&self) -> PathBuf {
        self.dir.path().join("capture-spool")
    }

    pub fn body(&self, index: usize) -> serde_json::Value {
        serde_json::from_str(&self.bodies.lock().unwrap()[index]).unwrap()
    }
}

pub fn write_jsonl(dir: &Path, name: &str, lines: &[serde_json::Value]) -> PathBuf {
    let file = dir.join(name);
    let text = lines
        .iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&file, text).unwrap();
    file
}

pub fn msgs(body: &serde_json::Value) -> &[serde_json::Value] {
    body["messages"].as_array().unwrap()
}

pub fn age_file(path: &Path, seconds: u64) {
    let file = std::fs::File::options().write(true).open(path).unwrap();
    let when = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(seconds))
        .unwrap();
    file.set_modified(when).unwrap();
}

pub fn occ_tail(id: &str) -> Option<(&str, &str)> {
    let rest = id.strip_prefix("claude-code:sess-1:occ:")?;
    let (hash, n) = rest.rsplit_once(':')?;
    if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some((hash, n))
    } else {
        None
    }
}
