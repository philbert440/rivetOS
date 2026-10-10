use std::path::{Component, Path, PathBuf};

use crate::context::ToolContext;

pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

pub fn node_resolve(base: &Path, target: &str) -> PathBuf {
    let target_path = Path::new(target);
    let combined = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        base.join(target_path)
    };
    let absolute = if combined.is_absolute() {
        combined
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(combined)
    };
    normalize_lexical(&absolute)
}

pub fn resolve_user_path(file_path: &str, context: &ToolContext) -> PathBuf {
    let path = Path::new(file_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        node_resolve(&context.base_dir(), file_path)
    }
}
