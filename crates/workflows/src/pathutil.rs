use std::path::{Path, PathBuf};

use protocol::js::posix_join;

pub fn node_join(parts: &[impl AsRef<str>]) -> PathBuf {
    let segments: Vec<&str> = parts.iter().map(|part| part.as_ref()).collect();
    PathBuf::from(posix_join(&segments))
}

pub fn node_join_paths(base: &Path, rel: &str) -> PathBuf {
    node_join(&[path_text(base).as_str(), rel])
}

pub fn path_text(path: &Path) -> String {
    path.to_str().unwrap_or("").to_string()
}

pub fn strip_trailing_slashes(text: &str) -> &str {
    text.trim_end_matches(['/', '\\'])
}

#[cfg(test)]
mod tests {
    use super::node_join;

    #[test]
    fn join_uses_the_shared_posix_helpers() {
        let collapsed = protocol::js::posix_normalize("a/../");
        assert_eq!(collapsed, "./");
        assert_eq!(node_join(&["a/../"]).to_str(), Some(collapsed.as_str()));
        assert_eq!(
            node_join(&["/data/runs", "run-1", "case.json"]).to_str(),
            Some("/data/runs/run-1/case.json")
        );
        let empty: [&str; 0] = [];
        assert_eq!(node_join(&empty).to_str(), Some("."));
    }
}
