use std::path::Path;

pub fn read_stat_error(err: &std::io::Error, path: &Path) -> String {
    read_special(err, path).unwrap_or_else(|| node_io_error(err, "stat", Some(path), None))
}

pub fn read_body_error(err: &std::io::Error, path: &Path) -> String {
    read_special(err, path).unwrap_or_else(|| node_io_error(err, "read", Some(path), None))
}

pub fn edit_fs_error(err: &protocol::host::FsError, path: &Path) -> String {
    match err.code {
        "ENOENT" => format!("Error: File not found: {}", path.display()),
        "EACCES" => format!("Error: Permission denied: {}", path.display()),
        _ => err.node_string(),
    }
}

pub fn write_mkdir_error(err: &std::io::Error, resolved: &Path, parent: &Path) -> String {
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        return format!("Error: Permission denied: {}", resolved.display());
    }
    node_io_error(err, "mkdir", Some(parent), None)
}

pub fn write_copy_error(err: &std::io::Error, resolved: &Path, bak: &Path) -> String {
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        return format!("Error: Permission denied: {}", resolved.display());
    }
    node_io_error(err, "copyfile", Some(resolved), Some(bak))
}

pub fn write_fs_error(err: &protocol::host::FsError, resolved: &Path) -> String {
    if err.code == "EACCES" {
        return format!("Error: Permission denied: {}", resolved.display());
    }
    err.node_string()
}

pub async fn write_node_text(
    path: &Path,
    body: &str,
    map: fn(&protocol::host::FsError, &Path) -> String,
) -> Result<(), String> {
    let owned = path.to_path_buf();
    let body = body.to_string();
    match tokio::task::spawn_blocking(move || protocol::host::write_text(&owned, &body)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(map(&err, path)),
        Err(err) => Err(format!("Error: {err}")),
    }
}

pub fn fixed_digits(value: f64, digits: f64) -> String {
    protocol::js::to_fixed(value, digits).unwrap_or_else(|_| protocol::js::number_to_string(value))
}

fn read_special(err: &std::io::Error, path: &Path) -> Option<String> {
    let shown = path.display();
    match err.kind() {
        std::io::ErrorKind::NotFound => Some(format!("Error: File not found: {shown}")),
        std::io::ErrorKind::PermissionDenied => Some(format!("Error: Permission denied: {shown}")),
        std::io::ErrorKind::IsADirectory => Some(format!("Error: Path is a directory: {shown}")),
        _ => None,
    }
}

fn node_io_error(
    err: &std::io::Error,
    syscall: &'static str,
    path: Option<&Path>,
    dest: Option<&Path>,
) -> String {
    let directory_read = syscall == "read"
        && (err.kind() == std::io::ErrorKind::IsADirectory || err.raw_os_error() == Some(21));
    let path = if directory_read { None } else { path };
    protocol::host::fs_error(syscall, path, dest, err).node_string()
}
