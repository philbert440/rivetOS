use std::path::{Path, PathBuf};

use protocol::js::js_trim;

pub const DEFAULT_SHARED_DIR: &str = "/rivet-shared";
pub const DEFAULT_INSTALL_ROOT: &str = "/opt/rivetos";

pub fn shared_dir() -> String {
    shared_dir_from(std::env::var("RIVETOS_SHARED_DIR").ok().as_deref())
}

pub fn shared_dir_from(raw: Option<&str>) -> String {
    match raw {
        Some(raw) => {
            let trimmed = js_trim(raw);
            if trimmed.is_empty() {
                DEFAULT_SHARED_DIR.to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => DEFAULT_SHARED_DIR.to_string(),
    }
}

pub fn shared_path(segments: &[&str]) -> String {
    path_join(&shared_dir(), segments)
}

pub fn install_root() -> String {
    install_root_from(std::env::var("RIVETOS_INSTALL_ROOT").ok().as_deref())
}

pub fn install_root_from(raw: Option<&str>) -> String {
    match raw {
        Some(raw) => {
            let trimmed = js_trim(raw);
            if trimmed.is_empty() {
                DEFAULT_INSTALL_ROOT.to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => DEFAULT_INSTALL_ROOT.to_string(),
    }
}

pub fn install_path(segments: &[&str]) -> String {
    path_join(&install_root(), segments)
}

pub fn path_join(root: &str, segments: &[&str]) -> String {
    if segments.is_empty() {
        return root.to_string();
    }
    let mut path = PathBuf::from(root);
    for segment in segments {
        path.push(segment);
    }
    path.to_string_lossy().into_owned()
}

pub fn home_dir() -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => home,
        _ => "/root".to_string(),
    }
}

pub fn mesh_file_paths(mesh_file: &str, shared_root: Option<&str>) -> Vec<String> {
    if !mesh_file.is_empty() {
        return vec![mesh_file.to_string()];
    }
    let shared = match shared_root {
        Some(root) => root.to_string(),
        None => shared_dir(),
    };
    vec![
        Path::new(&shared)
            .join("mesh.json")
            .to_string_lossy()
            .into_owned(),
        Path::new(&home_dir())
            .join(".rivetos")
            .join("mesh.json")
            .to_string_lossy()
            .into_owned(),
    ]
}

pub fn cli_mesh_paths(root: Option<&str>) -> Vec<String> {
    let mut paths = vec![shared_path(&["mesh.json"])];
    if let Some(root) = root {
        paths.push(resolve_under(root, "mesh.json"));
    }
    paths
}

fn resolve_under(root: &str, name: &str) -> String {
    let joined = Path::new(root).join(name);
    if joined.is_absolute() {
        return joined.to_string_lossy().into_owned();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(joined).to_string_lossy().into_owned(),
        Err(_) => joined.to_string_lossy().into_owned(),
    }
}
