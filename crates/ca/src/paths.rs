use std::path::PathBuf;

use config::paths::shared_path;
use protocol::host::Env;

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

    pub fn from_env(env: &dyn Env) -> Self {
        Self {
            root_dir: selected_dir(env, "RIVET_CA_ROOT_DIR", "/var/lib/rivet-ca/root"),
            shared_dir: selected_dir(env, "RIVET_CA_SHARED_DIR", &shared_path(env, &["rivet-ca"])),
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

fn selected_dir(env: &dyn Env, key: &str, default: &str) -> PathBuf {
    match env.var(key) {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(default),
    }
}

#[cfg(test)]
mod tests {
    use protocol::host::MapEnv;

    use super::CaPaths;

    #[test]
    fn root_and_shared_come_from_env() {
        let paths = CaPaths::from_env(&MapEnv::new());
        assert_eq!(paths.root_dir.as_os_str(), "/var/lib/rivet-ca/root");
        assert_eq!(paths.shared_dir.as_os_str(), "/rivet-shared/rivet-ca");

        let mut set = MapEnv::new();
        set.set("RIVET_CA_ROOT_DIR", "");
        set.set("RIVET_CA_SHARED_DIR", "");
        set.set("RIVETOS_SHARED_DIR", "  /data/shared  ");
        let paths = CaPaths::from_env(&set);
        assert_eq!(paths.root_dir.as_os_str(), "/var/lib/rivet-ca/root");
        assert_eq!(paths.shared_dir.as_os_str(), "/data/shared/rivet-ca");

        set.set("RIVET_CA_ROOT_DIR", "/ca/root");
        set.set("RIVET_CA_SHARED_DIR", "/ca/shared");
        let paths = CaPaths::from_env(&set);
        assert_eq!(paths.root_dir.as_os_str(), "/ca/root");
        assert_eq!(paths.shared_dir.as_os_str(), "/ca/shared");

        set.set("RIVET_CA_SHARED_DIR", " ");
        let paths = CaPaths::from_env(&set);
        assert_eq!(paths.shared_dir.as_os_str(), " ");
    }
}
