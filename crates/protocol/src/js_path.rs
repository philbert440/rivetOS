pub fn posix_is_absolute(path: &str) -> bool {
    path.as_bytes().first() == Some(&b'/')
}

pub fn posix_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let is_absolute = posix_is_absolute(path);
    let trailing = path.as_bytes().last() == Some(&b'/');
    let mut body = normalize_string(path, !is_absolute);
    if body.is_empty() && !is_absolute {
        body = ".".to_string();
    }
    if !body.is_empty() && trailing {
        body.push('/');
    }
    if is_absolute {
        let mut out = String::from("/");
        out.push_str(&body);
        out
    } else {
        body
    }
}

pub fn posix_join(segments: &[&str]) -> String {
    if segments.is_empty() {
        return ".".to_string();
    }
    let mut joined: Option<String> = None;
    for segment in segments {
        if segment.is_empty() {
            continue;
        }
        joined = Some(match joined {
            Some(current) => format!("{current}/{segment}"),
            None => (*segment).to_string(),
        });
    }
    match joined {
        Some(path) => posix_normalize(&path),
        None => ".".to_string(),
    }
}

pub fn posix_resolve(cwd: &str, segments: &[&str]) -> String {
    let mut resolved = String::new();
    let mut absolute = false;
    let mut index = segments.len() as isize - 1;
    while index >= -1 && !absolute {
        let path = if index >= 0 {
            segments[index as usize]
        } else {
            cwd
        };
        index -= 1;
        if path.is_empty() {
            continue;
        }
        resolved = format!("{path}/{resolved}");
        absolute = posix_is_absolute(path);
    }
    let body = normalize_string(&resolved, !absolute);
    if absolute {
        format!("/{body}")
    } else if body.is_empty() {
        ".".to_string()
    } else {
        body
    }
}

pub fn posix_relative(cwd: &str, from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from = posix_resolve(cwd, &[from]);
    let to = posix_resolve(cwd, &[to]);
    if from == to {
        return String::new();
    }
    relative_resolved(&from, &to)
}

fn relative_resolved(from: &str, to: &str) -> String {
    let from_bytes = from.as_bytes();
    let to_bytes = to.as_bytes();
    let from_end = from_bytes.len();
    let to_end = to_bytes.len();
    let from_start = body_start(from_bytes);
    let to_start = body_start(to_bytes);
    let from_len = from_end.saturating_sub(from_start);
    let to_len = to_end.saturating_sub(to_start);
    let length = from_len.min(to_len);
    let mut last_common_sep: Option<usize> = None;
    let mut index = 0usize;
    while index <= length {
        if index == length {
            if to_len > length {
                if byte_at(to_bytes, to_start, index) == Some(b'/') {
                    let at = to_start.saturating_add(index).saturating_add(1);
                    return slice_from(to, at);
                }
                if index == 0 {
                    return slice_from(to, to_start.saturating_add(index));
                }
            } else if from_len > length {
                if byte_at(from_bytes, from_start, index) == Some(b'/') {
                    last_common_sep = Some(index);
                } else if index == 0 {
                    last_common_sep = Some(0);
                }
            }
            break;
        }
        match (
            byte_at(from_bytes, from_start, index),
            byte_at(to_bytes, to_start, index),
        ) {
            (Some(from_code), Some(to_code)) if from_code == to_code => {
                if from_code == b'/' {
                    last_common_sep = Some(index);
                }
            }
            _ => break,
        }
        index = match index.checked_add(1) {
            Some(next) => next,
            None => break,
        };
    }
    let mut out = String::new();
    let mut cursor = walk_start(from_start, last_common_sep);
    while cursor <= from_end {
        if cursor == from_end || from_bytes.get(cursor) == Some(&b'/') {
            if out.is_empty() {
                out.push_str("..");
            } else {
                out.push_str("/..");
            }
        }
        cursor = match cursor.checked_add(1) {
            Some(next) => next,
            None => break,
        };
    }
    if !out.is_empty() {
        out.push_str(&slice_from(to, tail_index(to_start, last_common_sep)));
        out
    } else {
        let mut start = tail_index(to_start, last_common_sep);
        if to_bytes.get(start) == Some(&b'/') {
            start = start.saturating_add(1);
        }
        slice_from(to, start)
    }
}

fn body_start(bytes: &[u8]) -> usize {
    if bytes.first() != Some(&b'/') {
        return 0;
    }
    let mut start = 1usize;
    while bytes.get(start) == Some(&b'/') {
        start = match start.checked_add(1) {
            Some(next) => next,
            None => return start,
        };
    }
    start
}

fn byte_at(bytes: &[u8], start: usize, index: usize) -> Option<u8> {
    start
        .checked_add(index)
        .and_then(|pos| bytes.get(pos).copied())
}

fn walk_start(from_start: usize, sep: Option<usize>) -> usize {
    match sep {
        Some(index) => from_start.saturating_add(index).saturating_add(1),
        None => from_start,
    }
}

fn tail_index(start: usize, sep: Option<usize>) -> usize {
    match sep {
        Some(index) => start.saturating_add(index),
        None => start.saturating_sub(1),
    }
}

fn slice_from(text: &str, start: usize) -> String {
    match text.get(start..) {
        Some(tail) => tail.to_string(),
        None => String::new(),
    }
}

pub fn posix_dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let bytes = path.as_bytes();
    let has_root = bytes[0] == b'/';
    let mut end = -1isize;
    let mut matched_slash = true;
    let mut index = bytes.len() as isize - 1;
    while index >= 1 {
        if bytes[index as usize] == b'/' {
            if !matched_slash {
                end = index;
                break;
            }
        } else {
            matched_slash = false;
        }
        index -= 1;
    }
    if end == -1 {
        return if has_root {
            "/".to_string()
        } else {
            ".".to_string()
        };
    }
    if has_root && end == 1 {
        return "//".to_string();
    }
    path[..end as usize].to_string()
}

pub fn posix_basename(path: &str, suffix: Option<&str>) -> String {
    let bytes = path.as_bytes();
    if let Some(suffix) = suffix.filter(|suffix| !suffix.is_empty() && suffix.len() <= path.len()) {
        if suffix.len() == path.len() && suffix == path {
            return String::new();
        }
        let suffix_bytes = suffix.as_bytes();
        let mut start = 0usize;
        let mut end = -1isize;
        let mut matched_slash = true;
        let mut ext_idx = suffix_bytes.len() as isize - 1;
        let mut first_non_slash_end = -1isize;
        for index in (0..bytes.len()).rev() {
            if bytes[index] == b'/' {
                if !matched_slash {
                    start = index + 1;
                    break;
                }
            } else {
                if first_non_slash_end == -1 {
                    matched_slash = false;
                    first_non_slash_end = index as isize + 1;
                }
                if ext_idx >= 0 {
                    if bytes[index] == suffix_bytes[ext_idx as usize] {
                        ext_idx -= 1;
                        if ext_idx == -1 {
                            end = index as isize;
                        }
                    } else {
                        ext_idx = -1;
                        end = first_non_slash_end;
                    }
                }
            }
        }
        if start as isize == end {
            end = first_non_slash_end;
        } else if end == -1 {
            end = bytes.len() as isize;
        }
        return path[start..end as usize].to_string();
    }
    let mut start = 0usize;
    let mut end = -1isize;
    let mut matched_slash = true;
    for index in (0..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                start = index + 1;
                break;
            }
        } else if end == -1 {
            matched_slash = false;
            end = index as isize + 1;
        }
    }
    if end == -1 {
        String::new()
    } else {
        path[start..end as usize].to_string()
    }
}

pub fn posix_extname(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut start_dot = -1isize;
    let mut start_part = 0usize;
    let mut end = -1isize;
    let mut matched_slash = true;
    let mut pre_dot_state = 0i32;
    for index in (0..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                start_part = index + 1;
                break;
            }
            continue;
        }
        if end == -1 {
            matched_slash = false;
            end = index as isize + 1;
        }
        if bytes[index] == b'.' {
            if start_dot == -1 {
                start_dot = index as isize;
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot != -1 {
            pre_dot_state = -1;
        }
    }
    if start_dot == -1
        || end == -1
        || pre_dot_state == 0
        || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part as isize + 1)
    {
        return String::new();
    }
    path[start_dot as usize..end as usize].to_string()
}

fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let bytes = path.as_bytes();
    let mut result = String::new();
    let mut last_segment_length = 0usize;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u8 = 0;
    for index in 0..=bytes.len() {
        if index < bytes.len() {
            code = bytes[index];
        } else if code == b'/' {
            break;
        } else {
            code = b'/';
        }
        if code == b'/' {
            if last_slash == index as isize - 1 || dots == 1 {
            } else if dots == 2 {
                let can_pop = result.len() < 2
                    || last_segment_length != 2
                    || result.as_bytes()[result.len() - 1] != b'.'
                    || result.as_bytes()[result.len() - 2] != b'.';
                if can_pop {
                    if result.len() > 2 {
                        match result.rfind('/') {
                            Some(slash) => {
                                result.truncate(slash);
                                last_segment_length = match result.rfind('/') {
                                    Some(prev) => result.len() - prev - 1,
                                    None => result.len(),
                                };
                            }
                            None => {
                                result.clear();
                                last_segment_length = 0;
                            }
                        }
                        last_slash = index as isize;
                        dots = 0;
                        continue;
                    } else if !result.is_empty() {
                        result.clear();
                        last_segment_length = 0;
                        last_slash = index as isize;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if result.is_empty() {
                        result.push_str("..");
                    } else {
                        result.push_str("/..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let start = (last_slash + 1) as usize;
                if result.is_empty() {
                    result.push_str(&path[start..index]);
                } else {
                    result.push('/');
                    result.push_str(&path[start..index]);
                }
                last_segment_length = index - start;
            }
            last_slash = index as isize;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::posix_relative;

    #[test]
    fn relative_matches_node_for_disjoint_roots_and_cwd() {
        let cwd = "/home/example/work";
        assert_eq!(
            posix_relative(cwd, "/opt/rivetos", "/rivet-shared"),
            "../../rivet-shared"
        );
        assert_eq!(posix_relative(cwd, "/a", "/b"), "../b");
        assert_eq!(posix_relative(cwd, "/", "/a"), "a");
        assert_eq!(posix_relative(cwd, "/a", "/"), "..");
        assert_eq!(posix_relative(cwd, "/", "/"), "");
        assert_eq!(posix_relative(cwd, "a", "b"), "../b");
        assert_eq!(posix_relative(cwd, "a", "/b"), "../../../../b");
        assert_eq!(posix_relative(cwd, "", "b"), "b");
        assert_eq!(posix_relative(cwd, "..", "b"), "work/b");
        assert_eq!(posix_relative(cwd, "a/b", "a"), "..");
        assert_eq!(posix_relative(cwd, "a", "a/c"), "c");
        let _ = posix_relative("", "a", "b");
        let _ = posix_relative("rel", "a", "/b");
    }
}
