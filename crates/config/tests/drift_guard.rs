use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Part {
    Lit(String),
    Hole,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Template {
    parts: Vec<Part>,
}

#[derive(Clone, Debug)]
struct Hit {
    file: String,
    line: usize,
    template: Template,
}

struct Exempt {
    template: Template,
    reason: &'static str,
}

fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest.join("../..");
    std::fs::canonicalize(&root).unwrap_or(root)
}

fn collect_files(dir: &Path, extension: &str, out: &mut Vec<PathBuf>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|err| panic!("read {}: {err}", dir.display()));
    let mut paths = Vec::new();
    for entry in entries {
        paths.push(entry.unwrap_or_else(|err| panic!("{err}")).path());
    }
    paths.sort();
    for path in paths {
        if path.is_dir() {
            collect_files(&path, extension, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some(extension) {
            out.push(path);
        }
    }
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn rust_hits(root: &Path) -> Vec<Hit> {
    let mut files = Vec::new();
    collect_files(&root.join("crates/config/src"), "rs", &mut files);
    collect_files(&root.join("crates/protocol/src"), "rs", &mut files);
    files.sort();
    let mut hits = Vec::new();
    for path in files {
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("{}: {err}", path.display()));
        let file = relative(root, &path);
        hits.extend(rust_messages(&source, &file));
    }
    hits
}

fn ts_hits(root: &Path) -> Vec<Hit> {
    let mut files = Vec::new();
    collect_files(&root.join("packages/boot/src/validate"), "ts", &mut files);
    for extra in [
        "packages/boot/src/config.ts",
        "packages/types/src/harness-session-id.ts",
        "packages/types/src/errors.ts",
        "packages/types/src/provider.ts",
        "packages/types/src/task-result.ts",
        "packages/cli/src/lib/embedded.ts",
    ] {
        files.push(root.join(extra));
    }
    files.sort();
    let mut hits = Vec::new();
    for path in files {
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("{}: {err}", path.display()));
        let file = relative(root, &path);
        hits.extend(ts_messages(&source, &file));
    }
    hits
}

fn normalize(parts: Vec<Part>) -> Template {
    let mut out = Vec::new();
    for part in parts {
        match part {
            Part::Lit(text) if text.is_empty() => {}
            Part::Lit(text) => match out.last_mut() {
                Some(Part::Lit(prev)) => prev.push_str(&text),
                _ => out.push(Part::Lit(text)),
            },
            Part::Hole => out.push(Part::Hole),
        }
    }
    Template { parts: out }
}

fn rust_messages(source: &str, file: &str) -> Vec<Hit> {
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut hits = Vec::new();
    while index < bytes.len() {
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'/' {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index] == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'*' {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        if is_raw_start(bytes, index)
            && let Some((text, next)) = parse_raw(bytes, index)
        {
            consider_rust(&mut hits, file, source, index, &text, next);
            index = next;
            continue;
        }
        if bytes[index] == b'"'
            && !byte_string(bytes, index)
            && let Some((text, next)) = parse_rust_string(bytes, index)
        {
            consider_rust(&mut hits, file, source, index, &text, next);
            index = next;
            continue;
        }
        index += 1;
    }
    hits
}

fn consider_rust(
    hits: &mut Vec<Hit>,
    file: &str,
    source: &str,
    start: usize,
    text: &str,
    _end: usize,
) {
    if !interesting(text) || !binding_or_arg(source.as_bytes(), start) {
        return;
    }
    if ignored_argument(source.as_bytes(), start) {
        return;
    }
    let template = if format_string(source.as_bytes(), start) {
        split_format(text)
    } else {
        normalize(vec![Part::Lit(text.to_string())])
    };
    if template.parts.is_empty() {
        return;
    }
    hits.push(Hit {
        file: file.to_string(),
        line: line_of(source, start),
        template,
    });
}

fn interesting(text: &str) -> bool {
    text == "Errors:" || text == "Warnings:" || text.chars().any(char::is_whitespace)
}

fn binding_or_arg(bytes: &[u8], start: usize) -> bool {
    let mut index = start;
    while index > 0 && bytes[index - 1].is_ascii_whitespace() {
        index -= 1;
    }
    if index == 0 {
        return false;
    }
    match bytes[index - 1] {
        b'(' | b',' => true,
        b'=' => index < 2 || !matches!(bytes[index - 2], b'=' | b'!' | b'<' | b'>'),
        _ => false,
    }
}

fn ignored_argument(bytes: &[u8], start: usize) -> bool {
    let Some((_, ident)) = immediate_call(bytes, start) else {
        return false;
    };
    matches!(
        ident,
        b"join" | b"starts_with" | b"ends_with" | b"contains" | b"write_str" | b"push_str"
    )
}

fn immediate_call(bytes: &[u8], start: usize) -> Option<(usize, &[u8])> {
    let mut index = start;
    while index > 0 && bytes[index - 1].is_ascii_whitespace() {
        index -= 1;
    }
    if index == 0 || bytes[index - 1] != b'(' {
        return None;
    }
    index -= 1;
    while index > 0 && bytes[index - 1].is_ascii_whitespace() {
        index -= 1;
    }
    if index > 0 && bytes[index - 1] == b'!' {
        index -= 1;
        while index > 0 && bytes[index - 1].is_ascii_whitespace() {
            index -= 1;
        }
    }
    let end = index;
    while index > 0 && is_ident_byte(bytes[index - 1]) {
        index -= 1;
    }
    if index == end {
        return None;
    }
    Some((index, &bytes[index..end]))
}

fn format_string(bytes: &[u8], start: usize) -> bool {
    let mut index = start;
    while index > 0 && bytes[index - 1].is_ascii_whitespace() {
        index -= 1;
    }
    if index == 0 || bytes[index - 1] != b'(' {
        return false;
    }
    index -= 1;
    while index > 0 && bytes[index - 1].is_ascii_whitespace() {
        index -= 1;
    }
    if index > 0 && bytes[index - 1] == b'!' {
        index -= 1;
        while index > 0 && bytes[index - 1].is_ascii_whitespace() {
            index -= 1;
        }
    }
    let end = index;
    while index > 0 && (bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_') {
        index -= 1;
    }
    let ident = &bytes[index..end];
    ident == b"format" || ident == b"error"
}

fn split_format(text: &str) -> Template {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    let mut parts = Vec::new();
    let mut lit = String::new();
    while index < chars.len() {
        if chars[index] == '{' && index + 1 < chars.len() && chars[index + 1] == '{' {
            lit.push('{');
            index += 2;
            continue;
        }
        if chars[index] == '}' && index + 1 < chars.len() && chars[index + 1] == '}' {
            lit.push('}');
            index += 2;
            continue;
        }
        if chars[index] == '{' {
            let mut end = index + 1;
            while end < chars.len() && chars[end] != '}' {
                end += 1;
            }
            if end < chars.len() {
                flush_lit(&mut parts, &mut lit);
                parts.push(Part::Hole);
                index = end + 1;
                continue;
            }
        }
        lit.push(chars[index]);
        index += 1;
    }
    flush_lit(&mut parts, &mut lit);
    normalize(parts)
}

fn flush_lit(parts: &mut Vec<Part>, lit: &mut String) {
    if !lit.is_empty() {
        parts.push(Part::Lit(std::mem::take(lit)));
    }
}

fn line_of(source: &str, start: usize) -> usize {
    source.as_bytes()[..start.min(source.len())]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
        + 1
}

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn is_raw_start(bytes: &[u8], index: usize) -> bool {
    if bytes[index] != b'r' {
        return false;
    }
    if index > 0 && is_ident_byte(bytes[index - 1]) {
        return false;
    }
    let next = index + 1;
    next < bytes.len() && (bytes[next] == b'"' || bytes[next] == b'#')
}

fn byte_string(bytes: &[u8], index: usize) -> bool {
    index > 0 && bytes[index - 1] == b'b' && (index == 1 || !is_ident_byte(bytes[index - 2]))
}

fn parse_raw(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let mut index = start + 1;
    let mut hashes = 0usize;
    while index < bytes.len() && bytes[index] == b'#' {
        hashes += 1;
        index += 1;
    }
    if index >= bytes.len() || bytes[index] != b'"' {
        return None;
    }
    index += 1;
    let body = index;
    while index < bytes.len() {
        if bytes[index] == b'"' {
            let mut matched = 0;
            while matched < hashes
                && index + 1 + matched < bytes.len()
                && bytes[index + 1 + matched] == b'#'
            {
                matched += 1;
            }
            if matched == hashes {
                let text = std::str::from_utf8(&bytes[body..index]).ok()?.to_string();
                return Some((text, index + 1 + hashes));
            }
        }
        index += 1;
    }
    None
}

fn parse_rust_string(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let mut index = start + 1;
    let mut buf = Vec::new();
    while index < bytes.len() {
        match bytes[index] {
            b'"' => return Some((String::from_utf8(buf).ok()?, index + 1)),
            b'\\' => {
                index += 1;
                if index >= bytes.len() {
                    return None;
                }
                match bytes[index] {
                    b'n' => buf.push(b'\n'),
                    b'r' => buf.push(b'\r'),
                    b't' => buf.push(b'\t'),
                    b'\\' => buf.push(b'\\'),
                    b'\'' => buf.push(b'\''),
                    b'"' => buf.push(b'"'),
                    b'0' => buf.push(0),
                    b'u' => {
                        if index + 1 >= bytes.len() || bytes[index + 1] != b'{' {
                            return None;
                        }
                        index += 2;
                        let hex_start = index;
                        while index < bytes.len() && bytes[index] != b'}' {
                            index += 1;
                        }
                        if index >= bytes.len() {
                            return None;
                        }
                        let hex = std::str::from_utf8(&bytes[hex_start..index]).ok()?;
                        let code = u32::from_str_radix(hex, 16).ok()?;
                        let ch = char::from_u32(code)?;
                        let mut encoded = [0u8; 4];
                        buf.extend_from_slice(ch.encode_utf8(&mut encoded).as_bytes());
                    }
                    b'\n' => {
                        index += 1;
                        while index < bytes.len()
                            && matches!(bytes[index], b' ' | b'\t' | b'\n' | b'\r')
                        {
                            index += 1;
                        }
                        continue;
                    }
                    other => buf.push(other),
                }
                index += 1;
            }
            byte => {
                buf.push(byte);
                index += 1;
            }
        }
    }
    None
}

fn ts_messages(source: &str, file: &str) -> Vec<Hit> {
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    let mut hits = Vec::new();
    while index < chars.len() {
        if let Some(next) = skip_comment(&chars, index) {
            index = next;
            continue;
        }
        if at_literal(&chars, index) {
            let next = skip_syntax(&chars, index);
            index = if next > index { next } else { index + 1 };
            continue;
        }
        if let Some(next) = try_message(&chars, index, file, &mut hits) {
            index = if next > index { next } else { index + 1 };
            continue;
        }
        if let Some(next) = try_call(&chars, index, file, &mut hits) {
            index = if next > index { next } else { index + 1 };
            continue;
        }
        index += 1;
    }
    hits
}

fn at_literal(chars: &[char], index: usize) -> bool {
    matches!(chars.get(index), Some('\'' | '"' | '`')) || regex_at(chars, index)
}

fn try_message(chars: &[char], index: usize, file: &str, hits: &mut Vec<Hit>) -> Option<usize> {
    if !starts_ident(chars, index, "message") {
        return None;
    }
    let mut cursor = skip_ws(chars, index + "message".len());
    if chars.get(cursor) == Some(&'?') {
        cursor = skip_ws(chars, cursor + 1);
    }
    if chars.get(cursor) != Some(&':') {
        return None;
    }
    cursor = skip_ws(chars, cursor + 1);
    if let Some((template, next)) = parse_message_expr(chars, cursor) {
        push_hit(hits, file, chars, cursor, template);
        Some(next.max(index + 1))
    } else {
        Some(index + "message".len())
    }
}

fn try_call(chars: &[char], index: usize, file: &str, hits: &mut Vec<Hit>) -> Option<usize> {
    if starts_ident(chars, index, "invalid") && !preceded_by(chars, index, "function") {
        return call_arg(chars, index, "invalid", 0, file, hits);
    }
    if starts_ident(chars, index, "super") {
        return call_arg(chars, index, "super", 0, file, hits);
    }
    if starts_ident(chars, index, "lines") {
        return method_arg(chars, index, "lines", "push", 0, file, hits);
    }
    if starts_ident(chars, index, "log") {
        if let Some(next) = method_arg(chars, index, "log", "error", 0, file, hits) {
            return Some(next);
        }
        return method_arg(chars, index, "log", "warn", 0, file, hits);
    }
    if starts_ident(chars, index, "new") {
        let cursor = skip_ws(chars, index + 3);
        if starts_ident(chars, cursor, "Error") {
            return call_arg(chars, cursor, "Error", 0, file, hits);
        }
        if starts_ident(chars, cursor, "HarnessError") {
            return call_arg(chars, cursor, "HarnessError", 1, file, hits);
        }
        if starts_ident(chars, cursor, "Map") {
            return map_values(chars, cursor, file, hits);
        }
    }
    None
}

fn call_arg(
    chars: &[char],
    index: usize,
    word: &str,
    arg: usize,
    file: &str,
    hits: &mut Vec<Hit>,
) -> Option<usize> {
    if !starts_ident(chars, index, word) {
        return None;
    }
    let mut cursor = skip_ws(chars, index + word.len());
    if chars.get(cursor) != Some(&'(') {
        return None;
    }
    cursor += 1;
    for _ in 0..arg {
        cursor = skip_argument(chars, skip_ws(chars, cursor));
        if chars.get(cursor) != Some(&',') {
            return Some(cursor.max(index + 1));
        }
        cursor += 1;
    }
    cursor = skip_ws(chars, cursor);
    if let Some((template, next)) = parse_message_expr(chars, cursor) {
        push_hit(hits, file, chars, cursor, template);
        Some(next.max(index + 1))
    } else {
        Some(cursor.max(index + 1))
    }
}

fn method_arg(
    chars: &[char],
    index: usize,
    object: &str,
    method: &str,
    arg: usize,
    file: &str,
    hits: &mut Vec<Hit>,
) -> Option<usize> {
    if !starts_ident(chars, index, object) {
        return None;
    }
    let mut cursor = skip_ws(chars, index + object.len());
    if chars.get(cursor) != Some(&'.') {
        return None;
    }
    cursor = skip_ws(chars, cursor + 1);
    if !starts_ident(chars, cursor, method) {
        return None;
    }
    call_arg(chars, cursor, method, arg, file, hits)
}

fn map_values(chars: &[char], index: usize, file: &str, hits: &mut Vec<Hit>) -> Option<usize> {
    let mut cursor = skip_ws(chars, index + "Map".len());
    if chars.get(cursor) != Some(&'<') {
        return None;
    }
    let close = skip_braced_angle(chars, cursor)?;
    let inside: String = chars[cursor + 1..close - 1].iter().collect();
    if !inside.split(',').any(|part| part.trim() == "string")
        || inside.matches("string").count() < 2
    {
        return Some(close);
    }
    cursor = skip_ws(chars, close);
    if chars.get(cursor) != Some(&'(') {
        return Some(cursor);
    }
    cursor = skip_ws(chars, cursor + 1);
    if chars.get(cursor) != Some(&'[') {
        return Some(cursor + 1);
    }
    cursor += 1;
    while cursor < chars.len() {
        cursor = skip_ws(chars, cursor);
        if chars.get(cursor) == Some(&']') || chars.get(cursor).is_none() {
            break;
        }
        if chars.get(cursor) != Some(&'[') {
            cursor += 1;
            continue;
        }
        cursor = skip_ws(chars, cursor + 1);
        let key_end = skip_one_literal(chars, cursor);
        cursor = skip_ws(chars, key_end);
        if chars.get(cursor) == Some(&',') {
            cursor = skip_ws(chars, cursor + 1);
            if let Some((template, next)) = parse_message_expr(chars, cursor) {
                push_hit(hits, file, chars, cursor, template);
                cursor = next;
            }
        }
        cursor = skip_ws(chars, cursor);
        if chars.get(cursor) == Some(&',') {
            cursor = skip_ws(chars, cursor + 1);
        }
        if chars.get(cursor) == Some(&']') {
            cursor += 1;
        }
        cursor = skip_ws(chars, cursor);
        if chars.get(cursor) == Some(&',') {
            cursor += 1;
        }
    }
    Some(cursor.max(index + 1))
}

fn skip_braced_angle(chars: &[char], index: usize) -> Option<usize> {
    if chars.get(index) != Some(&'<') {
        return None;
    }
    let mut depth = 0i32;
    let mut cursor = index;
    while cursor < chars.len() {
        let next = skip_syntax(chars, cursor);
        if next != cursor {
            cursor = next;
            continue;
        }
        match chars[cursor] {
            '<' => depth += 1,
            '>' => {
                depth -= 1;
                cursor += 1;
                if depth == 0 {
                    return Some(cursor);
                }
                continue;
            }
            _ => {}
        }
        cursor += 1;
    }
    None
}

fn skip_one_literal(chars: &[char], index: usize) -> usize {
    if matches!(chars.get(index), Some('\'' | '"' | '`')) {
        let next = skip_syntax(chars, index);
        if next > index {
            return next;
        }
    }
    skip_argument(chars, index)
}

fn skip_argument(chars: &[char], index: usize) -> usize {
    let mut cursor = index;
    let mut paren = 0i32;
    let mut brace = 0i32;
    let mut bracket = 0i32;
    while cursor < chars.len() {
        let next = skip_syntax(chars, cursor);
        if next != cursor {
            cursor = next;
            continue;
        }
        match chars[cursor] {
            '(' => paren += 1,
            ')' if paren == 0 && brace == 0 && bracket == 0 => return cursor,
            ')' => paren -= 1,
            '{' => brace += 1,
            '}' if brace == 0 && paren == 0 && bracket == 0 => return cursor,
            '}' => brace -= 1,
            '[' => bracket += 1,
            ']' if bracket == 0 && paren == 0 && brace == 0 => return cursor,
            ']' => bracket -= 1,
            ',' if paren == 0 && brace == 0 && bracket == 0 => return cursor,
            _ => {}
        }
        cursor += 1;
    }
    cursor
}

fn push_hit(hits: &mut Vec<Hit>, file: &str, chars: &[char], index: usize, template: Template) {
    if template.parts.is_empty() {
        return;
    }
    hits.push(Hit {
        file: file.to_string(),
        line: char_line(chars, index),
        template,
    });
}

fn char_line(chars: &[char], index: usize) -> usize {
    chars[..index.min(chars.len())]
        .iter()
        .filter(|ch| **ch == '\n')
        .count()
        + 1
}

fn starts_ident(chars: &[char], index: usize, word: &str) -> bool {
    let word: Vec<char> = word.chars().collect();
    if index + word.len() > chars.len() || chars[index..index + word.len()] != word[..] {
        return false;
    }
    if index > 0 && ident_char(chars[index - 1]) {
        return false;
    }
    index + word.len() == chars.len() || !ident_char(chars[index + word.len()])
}

fn ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

fn preceded_by(chars: &[char], index: usize, word: &str) -> bool {
    let mut cursor = index;
    while cursor > 0 && chars[cursor - 1].is_whitespace() {
        cursor -= 1;
    }
    if cursor < word.len() {
        return false;
    }
    let start = cursor - word.len();
    starts_ident(chars, start, word) && start + word.len() == cursor
}

fn skip_ws(chars: &[char], mut index: usize) -> usize {
    while index < chars.len() {
        if let Some(next) = skip_comment(chars, index) {
            index = next;
            continue;
        }
        if chars[index].is_whitespace() {
            index += 1;
            continue;
        }
        break;
    }
    index
}

fn parse_message_expr(chars: &[char], mut index: usize) -> Option<(Template, usize)> {
    index = skip_ws(chars, index);
    let mut parts = Vec::new();
    let mut saw_literal = false;
    loop {
        index = skip_ws(chars, index);
        if index >= chars.len() || terminator(chars[index]) {
            break;
        }
        if chars[index] == '\'' || chars[index] == '"' {
            let (text, next) = parse_quoted(chars, index)?;
            parts.push(Part::Lit(text));
            saw_literal = true;
            index = next;
        } else if chars[index] == '`' {
            let (more, next) = parse_template(chars, index)?;
            parts.extend(more);
            saw_literal = true;
            index = next;
        } else {
            let next = skip_hole(chars, index);
            if next == index {
                break;
            }
            parts.push(Part::Hole);
            index = next;
        }
        index = skip_ws(chars, index);
        if index < chars.len() && chars[index] == '+' {
            index += 1;
            continue;
        }
        break;
    }
    if !saw_literal {
        return None;
    }
    Some((normalize(parts), index))
}

fn terminator(ch: char) -> bool {
    matches!(ch, ',' | ')' | '}' | ']' | ';')
}

fn skip_hole(chars: &[char], index: usize) -> usize {
    let mut cursor = index;
    let mut paren = 0i32;
    let mut brace = 0i32;
    let mut bracket = 0i32;
    while cursor < chars.len() {
        let next = skip_syntax(chars, cursor);
        if next != cursor {
            cursor = next;
            continue;
        }
        let ch = chars[cursor];
        if paren == 0 && brace == 0 && bracket == 0 && (ch == '+' || terminator(ch)) {
            return cursor;
        }
        match ch {
            '(' => paren += 1,
            ')' => paren -= 1,
            '{' => brace += 1,
            '}' => brace -= 1,
            '[' => bracket += 1,
            ']' => bracket -= 1,
            _ => {}
        }
        cursor += 1;
    }
    cursor
}

fn skip_syntax(chars: &[char], index: usize) -> usize {
    if let Some(next) = skip_comment(chars, index) {
        return next;
    }
    if matches!(chars.get(index), Some('\'' | '"'))
        && let Some((_, next)) = parse_quoted(chars, index)
    {
        return next;
    }
    if chars.get(index) == Some(&'`')
        && let Some((_, next)) = parse_template(chars, index)
    {
        return next;
    }
    if regex_at(chars, index) {
        return skip_regex(chars, index);
    }
    index
}

fn skip_comment(chars: &[char], index: usize) -> Option<usize> {
    if chars.get(index) != Some(&'/') {
        return None;
    }
    if chars.get(index + 1) == Some(&'/') {
        let mut cursor = index + 2;
        while cursor < chars.len() && chars[cursor] != '\n' {
            cursor += 1;
        }
        return Some(cursor);
    }
    if chars.get(index + 1) == Some(&'*') {
        let mut cursor = index + 2;
        while cursor + 1 < chars.len() && !(chars[cursor] == '*' && chars[cursor + 1] == '/') {
            cursor += 1;
        }
        return Some((cursor + 2).min(chars.len()));
    }
    None
}

fn regex_at(chars: &[char], index: usize) -> bool {
    if chars.get(index) != Some(&'/') {
        return false;
    }
    if matches!(chars.get(index + 1), Some('/' | '*')) {
        return false;
    }
    let mut cursor = index;
    while cursor > 0 {
        cursor -= 1;
        if chars[cursor].is_whitespace() {
            continue;
        }
        return !matches!(chars[cursor], '0'..='9' | 'a'..='z' | 'A'..='Z' | '_' | '$' | ')' | ']');
    }
    true
}

fn skip_regex(chars: &[char], index: usize) -> usize {
    let mut cursor = index + 1;
    let mut in_class = false;
    while cursor < chars.len() {
        if chars[cursor] == '\\' {
            cursor = (cursor + 2).min(chars.len());
            continue;
        }
        if chars[cursor] == '[' && !in_class {
            in_class = true;
            cursor += 1;
            continue;
        }
        if chars[cursor] == ']' && in_class {
            in_class = false;
            cursor += 1;
            continue;
        }
        if chars[cursor] == '/' && !in_class {
            cursor += 1;
            while cursor < chars.len() && chars[cursor].is_ascii_alphabetic() {
                cursor += 1;
            }
            return cursor;
        }
        if chars[cursor] == '\n' {
            return cursor;
        }
        cursor += 1;
    }
    cursor
}

fn parse_quoted(chars: &[char], index: usize) -> Option<(String, usize)> {
    let quote = chars[index];
    if quote != '\'' && quote != '"' {
        return None;
    }
    let mut cursor = index + 1;
    let mut out = String::new();
    while cursor < chars.len() {
        let ch = chars[cursor];
        if ch == '\\' {
            cursor += 1;
            if cursor >= chars.len() {
                return None;
            }
            out.push(decode_escape(chars, &mut cursor)?);
            continue;
        }
        if ch == quote {
            return Some((out, cursor + 1));
        }
        if ch == '\n' {
            return None;
        }
        out.push(ch);
        cursor += 1;
    }
    None
}

fn parse_template(chars: &[char], index: usize) -> Option<(Vec<Part>, usize)> {
    if chars.get(index) != Some(&'`') {
        return None;
    }
    let mut cursor = index + 1;
    let mut parts = Vec::new();
    let mut lit = String::new();
    while cursor < chars.len() {
        if chars[cursor] == '\\' {
            cursor += 1;
            if cursor >= chars.len() {
                return None;
            }
            lit.push(decode_escape(chars, &mut cursor)?);
            continue;
        }
        if chars[cursor] == '`' {
            flush_lit(&mut parts, &mut lit);
            return Some((parts, cursor + 1));
        }
        if chars[cursor] == '$' && chars.get(cursor + 1) == Some(&'{') {
            flush_lit(&mut parts, &mut lit);
            parts.push(Part::Hole);
            cursor = skip_braced(chars, cursor + 1)?;
            continue;
        }
        lit.push(chars[cursor]);
        cursor += 1;
    }
    None
}

fn skip_braced(chars: &[char], index: usize) -> Option<usize> {
    if chars.get(index) != Some(&'{') {
        return None;
    }
    let mut cursor = index;
    let mut depth = 0i32;
    while cursor < chars.len() {
        let next = skip_syntax(chars, cursor);
        if next != cursor {
            cursor = next;
            continue;
        }
        match chars[cursor] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                cursor += 1;
                if depth == 0 {
                    return Some(cursor);
                }
                continue;
            }
            _ => {}
        }
        cursor += 1;
    }
    None
}

fn decode_escape(chars: &[char], cursor: &mut usize) -> Option<char> {
    let ch = chars[*cursor];
    *cursor += 1;
    Some(match ch {
        'n' => '\n',
        'r' => '\r',
        't' => '\t',
        '\\' | '\'' | '"' | '`' | '$' | '{' | '}' => ch,
        'u' if chars.get(*cursor) == Some(&'{') => {
            *cursor += 1;
            let start = *cursor;
            while chars.get(*cursor).is_some_and(|ch| *ch != '}') {
                *cursor += 1;
            }
            let hex: String = chars[start..*cursor].iter().collect();
            if chars.get(*cursor) == Some(&'}') {
                *cursor += 1;
            }
            char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?
        }
        'u' => {
            let start = *cursor;
            if *cursor + 4 > chars.len() {
                return None;
            }
            *cursor += 4;
            let hex: String = chars[start..*cursor].iter().collect();
            char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?
        }
        other => other,
    })
}

fn show(template: &Template) -> String {
    let mut out = String::new();
    for part in &template.parts {
        match part {
            Part::Lit(text) => {
                out.push_str("lit ");
                out.push_str(&format!("{text:?}"));
                out.push(' ');
            }
            Part::Hole => out.push_str("hole "),
        }
    }
    out
}

fn report(kind: &str, hits: &[&Hit]) -> String {
    let mut lines = vec![format!("{kind}: {}", hits.len())];
    for hit in hits.iter().take(20) {
        lines.push(format!("{}:{} {}", hit.file, hit.line, show(&hit.template)));
    }
    lines.join("\n")
}

fn set_of(hits: &[Hit]) -> HashSet<Template> {
    hits.iter().map(|hit| hit.template.clone()).collect()
}

fn ts_exemptions() -> Vec<Exempt> {
    vec![
        exempt_ts(
            "'session id segment is not unpadded base64url'",
            "segment codec is outside this slice; parse checks the harness id only",
        ),
        exempt_ts(
            "'session id segment failed base64url decode'",
            "segment codec is outside this slice; parse checks the harness id only",
        ),
        exempt_ts(
            "'session id segment is not valid UTF-8'",
            "segment codec is outside this slice; parse checks the harness id only",
        ),
        exempt_ts(
            "'withEmbeddedPg: memory.postgres.embedded is not configured'",
            "acquire/close lifecycle is outside this slice; the port check is ported",
        ),
        exempt_ts(
            r"`Validation failed:\n${formatted}`",
            "boot loader log line; the Rust crate returns ValidationResult",
        ),
        exempt_ts(
            r"`${warn.path ? `[${warn.path}] ` : ''}${warn.message}`",
            "boot loader log wrapper around the ported warning line",
        ),
    ]
}

fn rust_exemptions() -> Vec<Exempt> {
    vec![
        exempt_fmt(
            "unknown {kind} value: {value}",
            "wire-enum FromStr error, not a TypeScript message",
        ),
        exempt_fmt(
            "Provider \"{name}\"",
            "label passed into token-field checks; operator sentences hole that label",
        ),
        exempt_lit(
            "Blocked: ",
            "prefix constant; the full template is pinned by tool_result_prefixes_match_typescript_templates",
        ),
        exempt_lit(
            "Error: ",
            "prefix constant; the full template is pinned by tool_result_prefixes_match_typescript_templates",
        ),
    ]
}

fn exempt_ts(snippet: &str, reason: &'static str) -> Exempt {
    let chars: Vec<char> = snippet.chars().collect();
    let (template, _) = parse_message_expr(&chars, 0).unwrap_or_else(|| panic!("exempt {snippet}"));
    Exempt { template, reason }
}

fn exempt_lit(text: &str, reason: &'static str) -> Exempt {
    Exempt {
        template: normalize(vec![Part::Lit(text.to_string())]),
        reason,
    }
}

fn exempt_fmt(text: &str, reason: &'static str) -> Exempt {
    Exempt {
        template: split_format(text),
        reason,
    }
}

fn find_exempt<'a>(template: &Template, table: &'a [Exempt]) -> Option<&'a Exempt> {
    table.iter().find(|item| item.template == *template)
}

#[test]
fn rust_message_templates_match_typescript() {
    let root = repo_root();
    let rust = rust_hits(&root);
    let ts = set_of(&ts_hits(&root));
    let table = rust_exemptions();
    let mut bad = Vec::new();
    let mut seen = HashSet::new();
    for hit in &rust {
        if ts.contains(&hit.template) || find_exempt(&hit.template, &table).is_some() {
            continue;
        }
        if seen.insert(hit.template.clone()) {
            bad.push(hit);
        }
    }
    assert!(
        bad.is_empty(),
        "{}",
        report("rust templates with no typescript counterpart", &bad)
    );
    for item in &table {
        let found = rust.iter().any(|hit| hit.template == item.template);
        let matched = ts.contains(&item.template);
        assert!(found && !matched, "stale rust exemption: {}", item.reason);
    }
}

#[test]
fn typescript_messages_have_one_rust_counterpart() {
    let root = repo_root();
    let ts = ts_hits(&root);
    let rust = set_of(&rust_hits(&root));
    let table = ts_exemptions();
    let mut bad = Vec::new();
    let mut seen = HashSet::new();
    for hit in &ts {
        if rust.contains(&hit.template) || find_exempt(&hit.template, &table).is_some() {
            continue;
        }
        if seen.insert(hit.template.clone()) {
            bad.push(hit);
        }
    }
    assert!(
        bad.is_empty(),
        "{}",
        report("typescript messages without one rust counterpart", &bad)
    );
    for item in &table {
        let found = ts.iter().any(|hit| hit.template == item.template);
        let matched = rust.contains(&item.template);
        assert!(
            found && !matched,
            "stale typescript exemption: {}",
            item.reason
        );
    }
}

#[test]
fn tool_result_prefixes_match_typescript_templates() {
    let root = repo_root();
    let rust = std::fs::read_to_string(root.join("crates/protocol/src/tool_result.rs")).unwrap();
    let ts = std::fs::read_to_string(root.join("packages/core/src/domain/tools-aisdk.ts")).unwrap();
    assert!(rust.contains("\"Blocked: \""), "{rust}");
    assert!(rust.contains("\"Error: \""), "{rust}");
    assert!(ts.contains("`Blocked: ${"), "{ts}");
    assert!(ts.contains("`Error: ${"), "{ts}");
}
