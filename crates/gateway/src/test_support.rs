use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{Mutex, MutexGuard};

static SCRATCH: AtomicU64 = AtomicU64::new(0);
static TOKENS: Mutex<()> = Mutex::const_new(());

pub async fn token_lock() -> MutexGuard<'static, ()> {
    TOKENS.lock().await
}

pub fn token_lock_blocking() -> MutexGuard<'static, ()> {
    TOKENS.blocking_lock()
}

pub fn scratch(label: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/gw-test");
    let dir = root.join(format!(
        "{}-{}-{}",
        std::process::id(),
        label,
        SCRATCH.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(dir.join("shared")).unwrap();
    std::fs::create_dir_all(dir.join("state")).unwrap();
    dir
}

pub fn isolated(dir: &Path) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert("HOME".to_string(), dir.to_string_lossy().into_owned());
    env.insert(
        "RIVETOS_SHARED_DIR".to_string(),
        dir.join("shared").to_string_lossy().into_owned(),
    );
    env.insert(
        "RIVETOS_DEN_STATE_DIR".to_string(),
        dir.join("state").to_string_lossy().into_owned(),
    );
    env.insert("RIVETOS_DEN_FILES_ROOT".to_string(), String::new());
    env.insert("PATH".to_string(), "/nonexistent-gw-path".to_string());
    env.insert("RIVETOS_DEN_PORT".to_string(), "0".to_string());
    env.insert("RIVETOS_DEN_HOST".to_string(), "127.0.0.1".to_string());
    env
}
