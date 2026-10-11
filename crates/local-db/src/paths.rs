use std::path::{Path, PathBuf};

pub const PGLITE_DIR_NAME: &str = "pglite";
pub const POSTGRES_DIR_NAME: &str = "postgres";
pub const PG_BIN_DIR_NAME: &str = "pg-bin";
pub const BACKUPS_DIR_NAME: &str = "backups";
pub const MIGRATE_DIR_NAME: &str = "migrate";
pub const RIVET_DIR_NAME: &str = ".rivetos";

pub fn rivet_dir(home: &Path) -> PathBuf {
    home.join(RIVET_DIR_NAME)
}

pub fn default_pglite_dir(home: &Path) -> PathBuf {
    rivet_dir(home).join(PGLITE_DIR_NAME)
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

pub fn cluster_dir_for(data_dir: &Path) -> PathBuf {
    if data_dir.file_name().and_then(|name| name.to_str()) == Some(PGLITE_DIR_NAME)
        && let Some(parent) = data_dir.parent()
        && !parent.as_os_str().is_empty()
    {
        return parent.join(POSTGRES_DIR_NAME);
    }
    let mut name = data_dir.file_name().unwrap_or_default().to_os_string();
    name.push(".postgres");
    match data_dir.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(name),
        _ => PathBuf::from(name),
    }
}

pub fn real_or_lexical(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(real) => real,
        Err(_) => lexical_absolute(path),
    }
}

pub fn real_of_nearest(path: &Path) -> PathBuf {
    let mut at = lexical_absolute(path);
    let mut rest = Vec::new();
    loop {
        if at.exists() {
            let mut resolved = real_or_lexical(&at);
            for part in rest.iter().rev() {
                resolved.push(part);
            }
            return resolved;
        }
        let Some(parent) = at.parent() else {
            return lexical_absolute(path);
        };
        if parent == at {
            return lexical_absolute(path);
        }
        if let Some(name) = at.file_name() {
            rest.push(name.to_os_string());
        }
        at = parent.to_path_buf();
    }
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
    let cwd = std::env::current_dir()
        .ok()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string());
    let text = path.to_string_lossy();
    PathBuf::from(protocol::js::posix_resolve(&cwd, &[text.as_ref()]))
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
    fn lexical_absolute_follows_posix_resolve() {
        let cwd = std::env::current_dir().expect("cwd");
        let cwd_text = cwd.to_string_lossy();
        let absolute = lexical_absolute(Path::new("/tmp/fake/../pglite"));
        assert_eq!(
            absolute,
            PathBuf::from(protocol::js::posix_resolve(
                &cwd_text,
                &["/tmp/fake/../pglite"]
            ))
        );
        assert_eq!(absolute, PathBuf::from("/tmp/pglite"));
        let relative = lexical_absolute(Path::new("fake/../pglite"));
        assert_eq!(
            relative,
            PathBuf::from(protocol::js::posix_resolve(&cwd_text, &["fake/../pglite"]))
        );
    }

    #[test]
    fn cluster_dir_keeps_the_default_and_suffixes_other_names() {
        assert_eq!(
            cluster_dir_for(Path::new("/home/rivet/.rivetos/pglite")),
            PathBuf::from("/home/rivet/.rivetos/postgres")
        );
        assert_eq!(
            cluster_dir_for(Path::new("/home/rivet/.rivetos/alt")),
            PathBuf::from("/home/rivet/.rivetos/alt.postgres")
        );
        assert_eq!(
            cluster_dir_for(Path::new("/tmp/fakehome/db")),
            PathBuf::from("/tmp/fakehome/db.postgres")
        );
    }
}
