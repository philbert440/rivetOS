use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use harness_executors::MapEnv;

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

const SCRIPT_RUNNER_BODY: &str =
    "#!/bin/bash\nexec \"${RR4D_INTERP:-/bin/bash}\" \"$RR4D_SCRIPT\" \"$@\"\n";

static SCRIPT_RUNNER: OnceLock<PathBuf> = OnceLock::new();

pub fn script_runner() -> PathBuf {
    SCRIPT_RUNNER
        .get_or_init(|| {
            let path = std::env::temp_dir().join(format!("rr4d-runner-{}.sh", std::process::id()));
            let stale = std::fs::read(&path)
                .map(|bytes| bytes != SCRIPT_RUNNER_BODY.as_bytes())
                .unwrap_or(true);
            if stale {
                let part =
                    std::env::temp_dir().join(format!("rr4d-runner-{}.part", std::process::id()));
                std::fs::write(&part, SCRIPT_RUNNER_BODY).unwrap();
                let mut perms = std::fs::metadata(&part).unwrap().permissions();
                use std::os::unix::fs::PermissionsExt;
                perms.set_mode(0o755);
                std::fs::set_permissions(&part, perms).unwrap();
                std::fs::rename(&part, &path).unwrap();
            }
            path
        })
        .clone()
}

pub struct Tmp {
    pub dir: PathBuf,
}

impl Tmp {
    pub fn new() -> Self {
        let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("rr4d-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

impl Default for Tmp {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn write_exe(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    path
}

pub fn map_env(extra: &[(&str, &str)]) -> MapEnv {
    let mut env = MapEnv::new();
    if let Ok(path) = std::env::var("PATH") {
        env.set("PATH", path);
    }
    for (key, value) in extra {
        env.set(*key, *value);
    }
    env
}
