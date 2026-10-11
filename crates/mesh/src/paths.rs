use std::path::Path;

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
    let mut parts = Vec::with_capacity(segments.len() + 1);
    parts.push(root);
    parts.extend_from_slice(segments);
    posix_join(&parts)
}

pub fn posix_join(parts: &[&str]) -> String {
    if parts.is_empty() {
        return ".".to_string();
    }
    let mut joined: Option<String> = None;
    for part in parts {
        if part.is_empty() {
            continue;
        }
        joined = Some(match joined {
            None => (*part).to_string(),
            Some(existing) => {
                let mut next = String::with_capacity(existing.len() + part.len() + 1);
                next.push_str(&existing);
                next.push('/');
                next.push_str(part);
                next
            }
        });
    }
    match joined {
        None => ".".to_string(),
        Some(text) => posix_normalize(&text),
    }
}

fn posix_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut body = normalize_string(path, !absolute);
    if body.is_empty() && !absolute {
        body.push('.');
    }
    if !body.is_empty() && trailing {
        body.push('/');
    }
    if absolute {
        let mut out = String::from("/");
        out.push_str(&body);
        out
    } else {
        body
    }
}

fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let chars: Vec<char> = path.chars().collect();
    let mut res = String::new();
    let mut last_segment_length = 0_usize;
    let mut last_slash = -1_isize;
    let mut dots = 0_i32;
    let mut code = '\0';
    let len = chars.len();
    for index in 0..=len {
        let index = index as isize;
        if (index as usize) < len {
            code = chars[index as usize];
        } else if code == '/' {
            break;
        } else {
            code = '/';
        }
        if code == '/' {
            let tail_is_dotdot = res.len() >= 2 && last_segment_length == 2 && res.ends_with("..");
            if last_slash == index - 1 || dots == 1 {
            } else if last_slash != index - 1 && dots == 2 && !tail_is_dotdot {
                if res.len() > 2 {
                    if let Some(slash) = res.rfind('/') {
                        res.truncate(slash);
                        last_segment_length = match res.rfind('/') {
                            Some(previous) => res.len() - 1 - previous,
                            None => res.len(),
                        };
                    } else {
                        res.clear();
                        last_segment_length = 0;
                    }
                    last_slash = index;
                    dots = 0;
                    continue;
                } else if res.len() == 2 || res.len() == 1 {
                    res.clear();
                    last_segment_length = 0;
                    last_slash = index;
                    dots = 0;
                    continue;
                } else if allow_above_root {
                    push_dotdot(&mut res);
                    last_segment_length = 2;
                }
            } else if last_slash != index - 1 && dots == 2 {
                if allow_above_root {
                    push_dotdot(&mut res);
                    last_segment_length = 2;
                }
            } else {
                let start = (last_slash + 1) as usize;
                let end = index as usize;
                let segment: String = chars[start..end].iter().collect();
                if res.is_empty() {
                    res = segment;
                } else {
                    res.push('/');
                    res.push_str(&segment);
                }
                last_segment_length = end.saturating_sub(start);
            }
            last_slash = index;
            dots = 0;
        } else if code == '.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

fn push_dotdot(res: &mut String) {
    if res.is_empty() {
        res.push_str("..");
    } else {
        res.push_str("/..");
    }
}

pub fn home_dir() -> String {
    if let Ok(home) = std::env::var("HOME")
        && !home.is_empty()
    {
        return home;
    }
    effective_uid()
        .and_then(|uid| {
            let text = std::fs::read_to_string("/etc/passwd").ok()?;
            home_from_passwd(&uid, &text)
        })
        .unwrap_or_default()
}

pub fn home_from_passwd(uid: &str, text: &str) -> Option<String> {
    for line in text.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split(':');
        let _name = parts.next()?;
        let _password = parts.next()?;
        let id = parts.next()?;
        let _group = parts.next()?;
        let _gecos = parts.next()?;
        let home = parts.next()?;
        if id == uid && !home.is_empty() {
            return Some(home.to_string());
        }
    }
    None
}

fn effective_uid() -> Option<String> {
    let text = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("Uid:") else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        let _real = fields.next()?;
        return fields.next().map(str::to_string);
    }
    None
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
        path_join(&shared, &["mesh.json"]),
        path_join(&home_dir(), &[".rivetos", "mesh.json"]),
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

#[cfg(test)]
mod posix_join_table {
    use super::home_from_passwd;
    use super::posix_join;

    #[test]
    fn node_documented_join_cases() {
        let cases = [
            (
                &["/foo", "bar", "baz/asdf", "quux", ".."][..],
                "/foo/bar/baz/asdf",
            ),
            (
                &["/opt/rivetos", "/config.yaml"][..],
                "/opt/rivetos/config.yaml",
            ),
            (&["/opt/rivetos", "a", "..", "b"][..], "/opt/rivetos/b"),
            (&["/opt//rivetos/", "a//b"][..], "/opt/rivetos/a/b"),
            (&["/opt/rivetos/foo/bar", ".."][..], "/opt/rivetos/foo"),
            (&["/opt", "..", ".."][..], "/"),
            (&["foo", "..", ".."][..], ".."),
            (&["/foo", "../../../bar"][..], "/bar"),
            (&["/mnt/shared/"][..], "/mnt/shared/"),
            (&["/rivet-shared"][..], "/rivet-shared"),
            (&["/opt/rivetos/", ""][..], "/opt/rivetos/"),
            (&["foo", "bar"][..], "foo/bar"),
            (&[""][..], "."),
            (&["", ""][..], "."),
            (&["/foo", ".", "bar"][..], "/foo/bar"),
            (&["foo/bar", "../baz"][..], "foo/baz"),
            (&["/foo/", "bar/"][..], "/foo/bar/"),
            (&["foo", "/bar", "baz"][..], "foo/bar/baz"),
            (&["/foo/bar//baz/asdf/quux/.."][..], "/foo/bar/baz/asdf"),
            (&["./"][..], "./"),
            (&["foo/bar", ".."][..], "foo"),
        ];
        for (parts, expected) in cases {
            assert_eq!(posix_join(parts), expected, "{parts:?}");
        }
    }

    #[test]
    fn passwd_home_matches_the_uid_field() {
        let text =
            "root:x:0:0:root:/root:/bin/bash\nrivet:x:1000:1000:Rivet:/home/rivet:/bin/bash\n";
        assert_eq!(
            home_from_passwd("1000", text).as_deref(),
            Some("/home/rivet")
        );
        assert_eq!(home_from_passwd("0", text).as_deref(), Some("/root"));
        assert_eq!(home_from_passwd("9", text), None);
    }
}
