use std::path::{Path, PathBuf};

pub fn node_join(parts: &[impl AsRef<str>]) -> PathBuf {
    let mut acc = String::new();
    for part in parts {
        let part = part.as_ref();
        if part.is_empty() {
            continue;
        }
        if acc.is_empty() {
            acc.push_str(part);
        } else {
            acc.push('/');
            acc.push_str(part);
        }
    }
    if acc.is_empty() {
        return PathBuf::from(".");
    }
    PathBuf::from(normalize_posix(&acc))
}

pub fn node_join_paths(base: &Path, rel: &str) -> PathBuf {
    node_join(&[path_text(base).as_str(), rel])
}

pub fn path_text(path: &Path) -> String {
    path.to_str().unwrap_or("").to_string()
}

pub fn normalize_posix(path: &str) -> String {
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/') && path != "/";
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            if absolute {
                if !parts.is_empty() {
                    parts.pop();
                }
            } else if parts.last().copied() == Some("..") || parts.is_empty() {
                parts.push("..");
            } else {
                parts.pop();
            }
            continue;
        }
        parts.push(segment);
    }
    let mut out = String::new();
    if absolute {
        out.push('/');
    }
    out.push_str(&parts.join("/"));
    if out.is_empty() {
        return if absolute {
            "/".to_string()
        } else {
            ".".to_string()
        };
    }
    if trailing && out != "/" {
        out.push('/');
    }
    out
}

pub fn strip_trailing_slashes(text: &str) -> &str {
    text.trim_end_matches(['/', '\\'])
}
