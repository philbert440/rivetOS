const AGENTS: &str = include_str!("../src/validate/agents.rs");
const CHANNELS: &str = include_str!("../src/validate/channels.rs");
const CROSS: &str = include_str!("../src/validate/cross.rs");
const DEN: &str = include_str!("../src/validate/den.rs");
const DEPLOYMENT: &str = include_str!("../src/validate/deployment.rs");
const KEYS: &str = include_str!("../src/validate/keys.rs");
const MEMORY: &str = include_str!("../src/validate/memory.rs");
const MESH: &str = include_str!("../src/validate/mesh.rs");
const VALIDATE: &str = include_str!("../src/validate/mod.rs");
const PATTERNS: &str = include_str!("../src/validate/patterns.rs");
const PROVIDERS: &str = include_str!("../src/validate/providers.rs");
const RUNTIME: &str = include_str!("../src/validate/runtime.rs");
const TASKS: &str = include_str!("../src/validate/tasks.rs");
const TOKEN: &str = include_str!("../src/validate/token.rs");
const EMBEDDED: &str = include_str!("../src/embedded.rs");
const ERROR: &str = include_str!("../src/error.rs");

const TS_INDEX: &str = include_str!("../../../packages/boot/src/validate/index.ts");
const TS_SECTIONS: &str = include_str!("../../../packages/boot/src/validate/sections.ts");
const TS_TYPES: &str = include_str!("../../../packages/boot/src/validate/types.ts");
const TS_CROSS: &str = include_str!("../../../packages/boot/src/validate/cross-refs.ts");
const TS_DEPLOYMENT: &str = include_str!("../../../packages/boot/src/validate/deployment.ts");
const TS_CONFIG: &str = include_str!("../../../packages/boot/src/config.ts");
const TS_EMBEDDED: &str = include_str!("../../../packages/cli/src/lib/embedded.ts");

#[test]
fn validation_messages_occur_in_typescript() {
    let mut templates = Vec::new();
    for source in [
        AGENTS, CHANNELS, CROSS, DEN, DEPLOYMENT, KEYS, MEMORY, MESH, VALIDATE, PATTERNS,
        PROVIDERS, RUNTIME, TASKS, TOKEN, EMBEDDED, ERROR,
    ] {
        templates.extend(message_templates(source));
    }
    assert!(templates.len() >= 198, "{}", templates.len());
    assert!(
        templates
            .iter()
            .any(|template| template.contains("must be an object"))
    );
    assert!(
        templates
            .iter()
            .any(|template| template.contains("Invalid regex:"))
    );
    assert!(
        templates
            .iter()
            .any(|template| template.contains("Config validation failed"))
    );
    let corpus = [
        TS_INDEX,
        TS_SECTIONS,
        TS_TYPES,
        TS_CROSS,
        TS_DEPLOYMENT,
        TS_CONFIG,
        TS_EMBEDDED,
    ]
    .into_iter()
    .map(collapse_concat)
    .collect::<Vec<_>>()
    .join("\n");
    let missing = templates
        .iter()
        .flat_map(|template| fragments(template))
        .filter(|fragment| !corpus_has(&corpus, fragment))
        .collect::<Vec<_>>();
    assert!(missing.is_empty(), "{missing:#?}");
}

fn corpus_has(corpus: &str, fragment: &str) -> bool {
    if corpus.contains(fragment) {
        return true;
    }
    let corpus: Vec<char> = corpus.chars().collect();
    let fragment: Vec<char> = fragment.chars().collect();
    corpus
        .iter()
        .enumerate()
        .any(|(index, ch)| *ch == fragment[0] && match_template(&corpus[index..], &fragment))
}

fn match_template(corpus: &[char], fragment: &[char]) -> bool {
    match_at(corpus, 0, fragment, 0)
}

fn match_at(corpus: &[char], ci: usize, fragment: &[char], fi: usize) -> bool {
    if fi == fragment.len() {
        return true;
    }
    if ci >= corpus.len() {
        return false;
    }
    if corpus[ci] == '$' && ci + 1 < corpus.len() && corpus[ci + 1] == '{' {
        let mut end = ci + 2;
        let mut depth = 1;
        while end < corpus.len() && depth > 0 {
            if corpus[end] == '{' {
                depth += 1;
            } else if corpus[end] == '}' {
                depth -= 1;
            }
            end += 1;
        }
        let mut take = 0;
        while fi + take <= fragment.len() && take <= 80 {
            if match_at(corpus, end, fragment, fi + take) {
                return true;
            }
            take += 1;
        }
        return false;
    }
    corpus[ci] == fragment[fi] && match_at(corpus, ci + 1, fragment, fi + 1)
}

fn collapse_concat(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '/' && index + 1 < chars.len() && chars[index + 1] == '/' {
            while index < chars.len() && chars[index] != '\n' {
                out.push(chars[index]);
                index += 1;
            }
            continue;
        }
        if chars[index] == '/' && index + 1 < chars.len() && chars[index + 1] == '*' {
            out.push(chars[index]);
            out.push(chars[index + 1]);
            index += 2;
            while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                out.push(chars[index]);
                index += 1;
            }
            if index < chars.len() {
                out.push(chars[index]);
                index += 1;
            }
            if index < chars.len() {
                out.push(chars[index]);
                index += 1;
            }
            continue;
        }
        if chars[index] == '/' && regex_position(&chars, index) {
            out.push('/');
            index += 1;
            while index < chars.len() {
                let ch = chars[index];
                out.push(ch);
                index += 1;
                if ch == '\\' && index < chars.len() {
                    out.push(chars[index]);
                    index += 1;
                    continue;
                }
                if ch == '/' {
                    break;
                }
            }
            continue;
        }
        if matches!(chars[index], '\'' | '"' | '`') {
            let quote = chars[index];
            out.push(quote);
            index += 1;
            while index < chars.len() {
                if chars[index] == '\\' && index + 1 < chars.len() {
                    let decoded = match chars[index + 1] {
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        '\\' => '\\',
                        '\'' => '\'',
                        '"' => '"',
                        '`' => '`',
                        other => other,
                    };
                    out.push(decoded);
                    index += 2;
                    continue;
                }
                if chars[index] == quote {
                    let mut look = index + 1;
                    while look < chars.len() && chars[look].is_whitespace() {
                        look += 1;
                    }
                    if look < chars.len() && chars[look] == '+' {
                        let mut after = look + 1;
                        while after < chars.len() && chars[after].is_whitespace() {
                            after += 1;
                        }
                        if after < chars.len() && matches!(chars[after], '\'' | '"' | '`') {
                            index = after + 1;
                            continue;
                        }
                    }
                    out.push(quote);
                    index += 1;
                    break;
                }
                out.push(chars[index]);
                index += 1;
            }
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn regex_position(chars: &[char], index: usize) -> bool {
    let mut prev = index;
    while prev > 0 {
        prev -= 1;
        if !chars[prev].is_whitespace() {
            return matches!(
                chars[prev],
                '(' | '=' | ',' | ':' | '[' | '!' | '&' | '|' | '?' | '{' | '}' | ';'
            );
        }
    }
    true
}

fn message_templates(source: &str) -> Vec<String> {
    rust_strings(source)
        .into_iter()
        .filter(|text| is_message_template(text))
        .collect()
}

fn is_message_template(text: &str) -> bool {
    if text.chars().count() < 4 {
        return false;
    }
    if text.chars().any(|ch| ch.is_whitespace() || !ch.is_ascii()) {
        return true;
    }
    matches!(
        text,
        "Errors:" | "Warnings:" | "error" | "errors" | "warning" | "warnings"
    )
}

fn fragments(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = template.chars().collect();
    let mut current = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '{' {
            if index + 1 < chars.len() && chars[index + 1] == '{' {
                current.push('{');
                index += 2;
                continue;
            }
            let mut end = index + 1;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            if end < chars.len() && chars[end] == '}' {
                push_fragment(&mut out, &mut current);
                index = end + 1;
                continue;
            }
        }
        if chars[index] == '}' && index + 1 < chars.len() && chars[index + 1] == '}' {
            current.push('}');
            index += 2;
            continue;
        }
        current.push(chars[index]);
        index += 1;
    }
    push_fragment(&mut out, &mut current);
    out
}

fn push_fragment(out: &mut Vec<String>, current: &mut String) {
    if current.chars().count() >= 4
        && current
            .chars()
            .any(|ch| ch.is_alphabetic() || !ch.is_ascii())
    {
        out.push(std::mem::take(current));
    } else {
        current.clear();
    }
}

fn rust_strings(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut out = Vec::new();
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
        if bytes[index] == b'r'
            && let Some(next) = skip_raw_string(bytes, index)
        {
            index = next;
            continue;
        }
        if bytes[index] == b'"'
            && let Some((text, next)) = parse_string(bytes, index)
        {
            out.push(text);
            index = next;
            continue;
        }
        index += 1;
    }
    out
}

fn skip_raw_string(bytes: &[u8], start: usize) -> Option<usize> {
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
                return Some(index + 1 + hashes);
            }
        }
        index += 1;
    }
    None
}

fn parse_string(bytes: &[u8], start: usize) -> Option<(String, usize)> {
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
                    _ => return None,
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
