use std::path::{Component, Path, PathBuf};

pub const PGLITE_DIR_NAME: &str = "pglite";
pub const POSTGRES_DIR_NAME: &str = "postgres";
pub const PG_BIN_DIR_NAME: &str = "pg-bin";
pub const BACKUPS_DIR_NAME: &str = "backups";
pub const MIGRATE_DIR_NAME: &str = "migrate";
pub const RIVET_DIR_NAME: &str = ".rivetos";

pub fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

pub fn rivet_dir(home: &Path) -> PathBuf {
    home.join(RIVET_DIR_NAME)
}

pub fn default_pglite_dir(home: &Path) -> PathBuf {
    rivet_dir(home).join(PGLITE_DIR_NAME)
}

pub fn postgres_data_dir(home: &Path) -> PathBuf {
    rivet_dir(home).join(POSTGRES_DIR_NAME)
}

pub fn postgres_bin_dir(home: &Path) -> PathBuf {
    rivet_dir(home).join(PG_BIN_DIR_NAME)
}

pub fn backups_dir(home: &Path) -> PathBuf {
    rivet_dir(home).join(BACKUPS_DIR_NAME)
}

pub fn migrate_dir(home: &Path) -> PathBuf {
    rivet_dir(home).join(MIGRATE_DIR_NAME)
}

pub fn expand_tilde(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(raw)
    }
}

pub fn lexical_absolute(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    normalize_lexical(&absolute)
}

pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_expands_only_at_the_start() {
        let home = Path::new("/home/rivet");
        assert_eq!(expand_tilde("~", home), PathBuf::from("/home/rivet"));
        assert_eq!(
            expand_tilde("~/.rivetos/pglite", home),
            PathBuf::from("/home/rivet/.rivetos/pglite")
        );
        assert_eq!(expand_tilde("/tmp/~x", home), PathBuf::from("/tmp/~x"));
        assert_eq!(expand_tilde("~user/x", home), PathBuf::from("~user/x"));
    }

    #[test]
    fn lexical_absolute_normalizes_dot_segments() {
        let path = lexical_absolute(Path::new("/tmp/fake/../pglite"));
        assert_eq!(path, PathBuf::from("/tmp/pglite"));
    }
}
