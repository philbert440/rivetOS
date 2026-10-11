pub(crate) fn is_absolute(path: &str) -> bool {
    protocol::js::posix_is_absolute(path)
}

pub(crate) fn basename(path: &str) -> String {
    protocol::js::posix_basename(path, None)
}

pub(crate) fn parent_dir(path: &str) -> String {
    protocol::js::posix_dirname(path)
}

pub(crate) fn posix_join(left: &str, right: &str) -> String {
    protocol::js::posix_join(&[left, right])
}

pub(crate) fn posix_resolve(base: &str, relative: &str, cwd: &str) -> String {
    protocol::js::posix_resolve(cwd, &[base, relative])
}

#[cfg(test)]
mod tests {
    use super::{basename, is_absolute, parent_dir, posix_join, posix_resolve};

    #[test]
    fn join_matches_node_posix() {
        assert_eq!(posix_join("/tmp/ws", "AGENT.md"), "/tmp/ws/AGENT.md");
        assert_eq!(
            posix_join("/tmp/ws", "users/profiles.json"),
            "/tmp/ws/users/profiles.json"
        );
        assert_eq!(
            posix_join("/tmp/ws", "deep/nested/file.md"),
            "/tmp/ws/deep/nested/file.md"
        );
        assert_eq!(posix_join("/tmp/ws", "/etc/passwd"), "/tmp/ws/etc/passwd");
        assert_eq!(posix_join("/tmp/ws", "../outside.md"), "/tmp/outside.md");
        assert_eq!(posix_join("/tmp/ws", "a/../../b"), "/tmp/b");
        assert_eq!(posix_join("a", "b/"), "a/b/");
        assert_eq!(posix_join("", "a"), "a");
        assert_eq!(posix_join("a", ""), "a");
    }

    #[test]
    fn resolve_matches_node_posix() {
        assert_eq!(
            posix_resolve("/tmp/ws", "src/app.ts", "/cwd"),
            "/tmp/ws/src/app.ts"
        );
        assert_eq!(
            posix_resolve("/tmp/ws", "../etc/passwd", "/cwd"),
            "/tmp/etc/passwd"
        );
        assert_eq!(
            posix_resolve("/tmp/ws", "/etc/passwd", "/cwd"),
            "/etc/passwd"
        );
        assert_eq!(posix_resolve("rel", "file.md", "/cwd"), "/cwd/rel/file.md");
    }

    #[test]
    fn basename_and_parent_and_absolute() {
        assert!(is_absolute("/etc/passwd"));
        assert!(!is_absolute("src/app.ts"));
        assert!(!is_absolute(""));
        assert_eq!(basename("/etc/passwd"), "passwd");
        assert_eq!(basename("src/app.ts"), "app.ts");
        assert_eq!(basename("/tmp/foo.txt/"), "foo.txt");
        assert_eq!(basename("/"), "");
        assert_eq!(
            parent_dir("/tmp/ws/deep/nested/file.md"),
            "/tmp/ws/deep/nested"
        );
        assert_eq!(parent_dir("file.md"), ".");
        assert_eq!(parent_dir("/file.md"), "/");
        assert_eq!(parent_dir(""), ".");
        assert_eq!(parent_dir("a/b/../c"), "a/b/..");
    }
}
