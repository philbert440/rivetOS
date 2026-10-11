use std::collections::HashSet;
use std::path::Path;

use crate::error::{LocalDbError, Result};
use crate::lock::{embedded_pg_lock_alive, read_embedded_pg_lock};

pub const STATUS_NOT_CONFIGURED: &str = "⚠️  embedded PGlite: not configured";
pub const STATUS_STOPPED_SUFFIX: &str = ", not running — start the node";
pub const STATUS_PREFIX_WARN: &str = "⚠️  embedded PGlite:";
pub const STATUS_PREFIX_OK: &str = "✅ embedded PGlite:";

pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let (scaled, unit) = if bytes < 1024 * 1024 {
        (bytes as f64 / 1024.0, "KB")
    } else {
        (bytes as f64 / (1024.0 * 1024.0), "MB")
    };
    let text = protocol::js::to_fixed(scaled, 1.0).unwrap_or_else(|_| String::from("0.0"));
    format!("{text} {unit}")
}

pub fn dir_size_bytes(dir: &Path) -> u64 {
    let mut seen = HashSet::new();
    let mut total = 0u64;
    walk_size(dir, &mut seen, &mut total);
    total
}

pub fn format_local_status(dir: &Path, running: bool, pid: Option<i64>) -> String {
    let size = format_bytes(dir_size_bytes(dir));
    let shown = dir.display();
    if running && let Some(pid) = pid {
        return format!("{STATUS_PREFIX_OK} {shown} ({size}), owner pid {pid}");
    }
    format!("{STATUS_PREFIX_WARN} {shown} ({size}){STATUS_STOPPED_SUFFIX}")
}

pub fn local_status_line(dir: &Path) -> String {
    let lock = read_embedded_pg_lock(dir);
    let running = lock.as_ref().is_some_and(embedded_pg_lock_alive);
    let pid = lock.as_ref().map(|lock| lock.pid);
    format_local_status(dir, running, pid)
}

pub async fn local_status_line_async(dir: &Path) -> Result<String> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || local_status_line(&dir))
        .await
        .map_err(|error| LocalDbError::message(error.to_string()))
}

pub fn db_status_lines(data_dir: &Path, config_port: i64, owned: bool) -> Vec<String> {
    let lock = read_embedded_pg_lock(data_dir);
    let alive = lock.as_ref().is_some_and(embedded_pg_lock_alive);
    let size = format_bytes(dir_size_bytes(data_dir));
    let port = lock.as_ref().map(|lock| lock.port).unwrap_or(config_port);
    let mut lines = vec![
        "[db status] embedded PGlite".to_string(),
        format!("  data_dir: {}", data_dir.display()),
        format!("  size: {size}"),
    ];
    if owned {
        lines.push("  owner: this command (no node running)".to_string());
    } else if let Some(lock) = lock {
        let state = if alive { "alive" } else { "dead" };
        lines.push(format!("  owner_pid: {} ({state})", lock.pid));
    } else {
        lines.push("  owner_pid: none".to_string());
    }
    lines.push(format!("  port: {port}"));
    lines
}

fn walk_size(path: &Path, seen: &mut HashSet<(u64, u64)>, total: &mut u64) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !seen.insert((meta.dev(), meta.ino())) {
            return;
        }
    }
    if meta.is_file() {
        *total += meta.len();
        return;
    }
    if !meta.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        walk_size(&entry.path(), seen, total);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::lock_path;

    fn read_repo(parts: &[&str]) -> String {
        let mut path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.pop();
        path.pop();
        for part in parts {
            path.push(part);
        }
        std::fs::read_to_string(&path).expect("repo file")
    }

    #[test]
    fn format_bytes_matches_javascript_to_fixed() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(1024 * 1024 + 512 * 1024), "1.5 MB");
    }

    #[test]
    fn status_prefixes_match_the_typescript_cli() {
        let source = read_repo(&["packages", "cli", "src", "commands", "local.ts"]);
        assert!(source.contains(STATUS_PREFIX_WARN));
        assert!(source.contains(STATUS_PREFIX_OK));
        assert!(source.contains("not running — start the node"));
        let db = read_repo(&["packages", "cli", "src", "commands", "db.ts"]);
        assert!(db.contains("[db status] embedded PGlite"));
        assert!(db.contains("  owner: this command (no node running)"));
        let missing = Path::new("/no/such/local-db-status-dir");
        let stopped = format_local_status(missing, false, None);
        assert!(stopped.starts_with(STATUS_PREFIX_WARN));
        assert!(stopped.contains("/no/such/local-db-status-dir"));
        assert!(stopped.contains(STATUS_STOPPED_SUFFIX));
        let running = format_local_status(missing, true, Some(15));
        assert_eq!(
            running,
            format!("{STATUS_PREFIX_OK} /no/such/local-db-status-dir (0 B), owner pid 15")
        );
        assert_eq!(STATUS_NOT_CONFIGURED, "⚠️  embedded PGlite: not configured");
    }

    #[test]
    fn db_status_rows_follow_the_cli_header() {
        let dir = std::env::temp_dir().join(format!(
            "local-db-status-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        let owned = db_status_lines(&dir, 5433, true);
        assert_eq!(owned[0], "[db status] embedded PGlite");
        assert_eq!(owned[1], format!("  data_dir: {}", dir.display()));
        assert!(owned[2].starts_with("  size: "));
        assert_eq!(owned[3], "  owner: this command (no node running)");
        assert_eq!(owned[4], "  port: 5433");
        let none = db_status_lines(&dir, 5433, false);
        assert_eq!(none[3], "  owner_pid: none");
        std::fs::write(
            lock_path(&dir),
            serde_json::json!({"pid": i32::MAX, "port": 6000, "startedAt": "t"}).to_string(),
        )
        .expect("lock");
        let dead = db_status_lines(&dir, 5433, false);
        assert_eq!(dead[3], format!("  owner_pid: {} (dead)", i32::MAX));
        assert_eq!(dead[4], "  port: 6000");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_size_sums_files_and_skips_a_symlink_cycle() {
        let dir = std::env::temp_dir().join(format!(
            "local-db-size-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(dir.join("nested")).expect("dir");
        std::fs::write(dir.join("nested").join("a.txt"), b"abcd").expect("file");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&dir, dir.join("loop")).expect("symlink");
        assert_eq!(dir_size_bytes(&dir), 4);
        assert_eq!(dir_size_bytes(Path::new("/no/such/local-db-dir")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
