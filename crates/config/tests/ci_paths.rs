use std::path::{Component, Path, PathBuf};

fn repo_root() -> PathBuf {
    normalize(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|err| panic!("{}: {err}", dir.display()));
    let mut paths = Vec::new();
    for entry in entries {
        paths.push(entry.unwrap_or_else(|err| panic!("{err}")).path());
    }
    paths.sort();
    for path in paths {
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn path_lists(yaml: &str) -> Vec<Vec<String>> {
    let mut lists = Vec::new();
    let mut lines = yaml.lines();
    while let Some(line) = lines.next() {
        if line.trim() != "paths:" {
            continue;
        }
        let mut items = Vec::new();
        for item in lines.by_ref() {
            let trimmed = item.trim();
            if let Some(rest) = trimmed.strip_prefix("- ") {
                items.push(rest.trim().to_string());
            } else {
                break;
            }
        }
        lists.push(items);
    }
    lists
}

fn referenced_paths(source: &str, file: &Path) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut found = Vec::new();
    while index < bytes.len() {
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'/') {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        if bytes[index] == b'\'' {
            index = skip_char_literal(bytes, index);
            continue;
        }
        if let Some((text, next)) = parse_include(bytes, index, file) {
            found.push(text);
            index = next;
            continue;
        }
        if let Some((text, next)) = parse_raw(bytes, index) {
            found.extend(path_mentions(&text));
            index = next;
            continue;
        }
        if let Some((text, next)) = parse_cooked(bytes, index) {
            found.extend(path_mentions(&text));
            index = next;
            continue;
        }
        index += 1;
    }
    found
}

fn parse_include(bytes: &[u8], start: usize, file: &Path) -> Option<(String, usize)> {
    let marker = b"include_str!";
    if !bytes[start..].starts_with(marker) {
        return None;
    }
    let mut index = start + marker.len();
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    if bytes.get(index) != Some(&b'(') {
        return None;
    }
    index += 1;
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    let (text, next) = parse_cooked(bytes, index)?;
    Some((resolve_include(file, &text), next))
}

fn resolve_include(file: &Path, rel: &str) -> String {
    let joined = file.parent().unwrap().join(rel);
    let full = normalize(&joined);
    let root = repo_root();
    let relative = full
        .strip_prefix(&root)
        .unwrap_or_else(|_| panic!("{} does not sit under {}", full.display(), root.display()));
    relative.to_string_lossy().replace('\\', "/")
}

fn parse_raw(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let hashes = raw_hashes(bytes, start)?;
    let mut index = start;
    if bytes[index] == b'b' {
        index += 1;
    }
    index += 1 + hashes + 1;
    let body = index;
    while index < bytes.len() {
        if bytes[index] == b'"' && hash_run(bytes, index + 1, hashes) {
            let text = std::str::from_utf8(&bytes[body..index]).ok()?.to_string();
            return Some((text, index + 1 + hashes));
        }
        index += 1;
    }
    None
}

fn raw_hashes(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start;
    if bytes.get(index) == Some(&b'b') {
        index += 1;
    }
    if bytes.get(index) != Some(&b'r') {
        return None;
    }
    index += 1;
    let mut hashes = 0;
    while bytes.get(index) == Some(&b'#') {
        hashes += 1;
        index += 1;
    }
    if bytes.get(index) == Some(&b'"') {
        Some(hashes)
    } else {
        None
    }
}

fn hash_run(bytes: &[u8], start: usize, hashes: usize) -> bool {
    (0..hashes).all(|offset| bytes.get(start + offset) == Some(&b'#'))
}

fn parse_cooked(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let mut index = start;
    if bytes.get(index) == Some(&b'b') && bytes.get(index + 1) == Some(&b'"') {
        index += 1;
    }
    if bytes.get(index) != Some(&b'"') {
        return None;
    }
    index += 1;
    let mut out = String::new();
    while index < bytes.len() {
        match bytes[index] {
            b'"' => return Some((out, index + 1)),
            b'\\' => {
                index += 1;
                let byte = *bytes.get(index)?;
                index += 1;
                match byte {
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'\\' => out.push('\\'),
                    b'\'' => out.push('\''),
                    b'"' => out.push('"'),
                    b'0' => out.push('\0'),
                    b'x' => {
                        let hex = std::str::from_utf8(bytes.get(index..index + 2)?).ok()?;
                        let code = u8::from_str_radix(hex, 16).ok()?;
                        out.push(char::from(code));
                        index += 2;
                    }
                    b'u' => {
                        if bytes.get(index) != Some(&b'{') {
                            return None;
                        }
                        index += 1;
                        let hex_start = index;
                        while index < bytes.len() && bytes[index] != b'}' {
                            index += 1;
                        }
                        let hex = std::str::from_utf8(bytes.get(hex_start..index)?).ok()?;
                        let code = u32::from_str_radix(hex, 16).ok()?;
                        out.push(char::from_u32(code)?);
                        index += 1;
                    }
                    b'\n' => {}
                    b'\r' => {
                        if bytes.get(index) == Some(&b'\n') {
                            index += 1;
                        }
                    }
                    other => out.push(char::from(other)),
                }
            }
            byte if byte < 0x80 => {
                out.push(char::from(byte));
                index += 1;
            }
            _ => {
                let rest = std::str::from_utf8(bytes.get(index..)?).ok()?;
                let ch = rest.chars().next()?;
                out.push(ch);
                index += ch.len_utf8();
            }
        }
    }
    None
}

fn skip_char_literal(bytes: &[u8], start: usize) -> usize {
    let mut index = start + 1;
    if bytes.get(index) == Some(&b'\\') {
        index += 1;
        if bytes.get(index) == Some(&b'x') {
            index += 3;
        } else if bytes.get(index) == Some(&b'u') {
            index += 1;
            if bytes.get(index) == Some(&b'{') {
                index += 1;
                while index < bytes.len() && bytes[index] != b'}' {
                    index += 1;
                }
                index += 1;
            }
        } else {
            index += 1;
        }
    } else {
        index += 1;
        while index < bytes.len() && bytes[index] & 0xC0 == 0x80 {
            index += 1;
        }
    }
    if bytes.get(index) == Some(&b'\'') {
        index + 1
    } else {
        start + 1
    }
}

fn path_mentions(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for token in text.split(|ch: char| {
        ch.is_whitespace()
            || matches!(
                ch,
                '"' | '\'' | '`' | ',' | '(' | ')' | '{' | '}' | ';' | '[' | ']'
            )
    }) {
        let Some(start) = token.find("packages/").or_else(|| token.find("plugins/")) else {
            continue;
        };
        let path = &token[start..];
        if path == "packages/" || path == "plugins/" {
            continue;
        }
        out.push(path.to_string());
    }
    out
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    glob_bytes(pattern.as_bytes(), path.as_bytes())
}

fn glob_bytes(pattern: &[u8], path: &[u8]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern.starts_with(b"**") {
        let mut rest = &pattern[2..];
        if rest.first() == Some(&b'/') {
            rest = &rest[1..];
        }
        if rest.is_empty() {
            return true;
        }
        if glob_bytes(rest, path) {
            return true;
        }
        let mut index = 0;
        while index < path.len() {
            index += 1;
            if glob_bytes(rest, &path[index..]) {
                return true;
            }
        }
        return false;
    }
    if pattern[0] == b'*' {
        if glob_bytes(&pattern[1..], path) {
            return true;
        }
        if path.first().is_some_and(|byte| *byte != b'/') {
            return glob_bytes(pattern, &path[1..]);
        }
        return false;
    }
    if path.is_empty() || pattern[0] != path[0] {
        return false;
    }
    glob_bytes(&pattern[1..], &path[1..])
}

#[test]
fn workflow_paths_cover_every_package_and_plugin_input() {
    assert!(glob_matches(
        "crates/**",
        "crates/config/tests/golden/v8-regex-g.node24.json"
    ));
    assert!(glob_matches(
        "packages/core/src/**",
        "packages/core/src/domain/tools-aisdk.ts"
    ));
    assert!(!glob_matches(
        "crates/**",
        "packages/core/src/domain/tools-aisdk.ts"
    ));
    let mut outside = String::from("pack");
    outside.push_str("ages/core/other.ts");
    assert!(!glob_matches("packages/core/src/**", &outside));

    let root = repo_root();
    let yaml = std::fs::read_to_string(root.join(".github/workflows/rust.yml")).unwrap();
    let lists = path_lists(&yaml);
    assert_eq!(lists.len(), 2);
    let mut files = Vec::new();
    collect_rs(&root.join("crates"), &mut files);
    let mut referenced = Vec::new();
    for file in files {
        let source = std::fs::read_to_string(&file).unwrap();
        referenced.extend(referenced_paths(&source, &file));
    }
    referenced.sort();
    referenced.dedup();
    assert!(
        referenced
            .iter()
            .any(|path| path.ends_with("v8-regex-g.node24.json")),
        "{referenced:?}"
    );
    assert!(
        referenced
            .iter()
            .any(|path| path.ends_with("packages/core/src/domain/tools-aisdk.ts")),
        "{referenced:?}"
    );
    let mut missing = Vec::new();
    for path in &referenced {
        for (index, list) in lists.iter().enumerate() {
            if !list.iter().any(|glob| glob_matches(glob, path)) {
                missing.push(format!("list {index} misses {path}"));
            }
        }
    }
    assert!(missing.is_empty(), "{}", missing.join("\n"));
}
