pub(crate) fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
}

pub(crate) fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "";
    }
    match trimmed.rfind('/') {
        Some(index) => &trimmed[index + 1..],
        None => trimmed,
    }
}

pub(crate) fn parent_dir(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let bytes = path.as_bytes();
    let mut end = None;
    let mut matched_slash = true;
    let mut index = bytes.len();
    while index > 1 {
        index -= 1;
        if bytes[index] == b'/' {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None => {
            if bytes[0] == b'/' {
                "/".to_string()
            } else {
                ".".to_string()
            }
        }
        Some(0) => "/".to_string(),
        Some(split) => path[..split].to_string(),
    }
}

pub(crate) fn posix_join(left: &str, right: &str) -> String {
    let joined = match (left.is_empty(), right.is_empty()) {
        (true, true) => String::new(),
        (true, false) => right.to_string(),
        (false, true) => left.to_string(),
        (false, false) => format!("{left}/{right}"),
    };
    posix_normalize(&joined)
}

pub(crate) fn posix_resolve(base: &str, relative: &str, cwd: &str) -> String {
    let mut resolved = String::new();
    let mut absolute = false;
    for part in [relative, base, cwd] {
        if part.is_empty() {
            continue;
        }
        if resolved.is_empty() {
            resolved = part.to_string();
        } else {
            resolved = format!("{part}/{resolved}");
        }
        if part.starts_with('/') {
            absolute = true;
            break;
        }
    }
    if !absolute && !cwd.is_empty() && !resolved.starts_with('/') {
        resolved = format!("{cwd}/{resolved}");
    }
    let normalized = posix_normalize(&resolved);
    if normalized.len() > 1 && normalized.ends_with('/') {
        normalized.trim_end_matches('/').to_string()
    } else if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

fn posix_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/') && path != "/";
    let mut stack: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|top| *top != "..") {
                    stack.pop();
                } else if !absolute {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }
    let mut out = String::new();
    if absolute {
        out.push('/');
    }
    out.push_str(&stack.join("/"));
    if out.is_empty() {
        return ".".to_string();
    }
    if trailing && out != "/" {
        out.push('/');
    }
    out
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
