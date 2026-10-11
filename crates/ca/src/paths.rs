use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaPaths {
    pub root_dir: PathBuf,
    pub shared_dir: PathBuf,
}

impl CaPaths {
    pub fn new(root_dir: impl Into<PathBuf>, shared_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
            shared_dir: shared_dir.into(),
        }
    }

    pub fn from_env() -> Self {
        Self {
            root_dir: env_path("RIVET_CA_ROOT_DIR", "/var/lib/rivet-ca/root"),
            shared_dir: env_path("RIVET_CA_SHARED_DIR", "/rivet-shared/rivet-ca"),
        }
    }

    pub fn int_dir(&self) -> PathBuf {
        self.shared_dir.join("intermediate")
    }

    pub fn issued_dir(&self) -> PathBuf {
        self.shared_dir.join("issued")
    }

    pub fn crl_path(&self) -> PathBuf {
        self.shared_dir.join("crl.pem")
    }

    pub fn chain_path(&self) -> PathBuf {
        self.int_dir().join("chain.pem")
    }
}

fn env_path(key: &str, default: &str) -> PathBuf {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(default),
    }
}
