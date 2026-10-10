const SESSION_ID: &str = include_str!("../src/session_id.rs");
const HARNESS_SESSION_ID: &str = include_str!("../../../packages/types/src/harness-session-id.ts");
const ERRORS: &str = include_str!("../../../packages/types/src/errors.ts");
const PROVIDER: &str = include_str!("../../../packages/types/src/provider.ts");
const TASK: &str = include_str!("../../../packages/types/src/task.ts");
const TASK_RESULT: &str = include_str!("../../../packages/types/src/task-result.ts");
const EVENTS: &str = include_str!("../../../packages/types/src/events.ts");
const MESSAGE: &str = include_str!("../../../packages/types/src/message.ts");
const CHANNEL: &str = include_str!("../../../packages/types/src/channel.ts");
const HOOKS: &str = include_str!("../../../packages/types/src/hooks.ts");
const TOOL: &str = include_str!("../../../packages/types/src/tool.ts");

#[test]
fn session_id_messages_occur_in_typescript() {
    let templates = message_templates(SESSION_ID);
    assert!(templates.len() >= 5, "{}", templates.len());
    assert!(
        templates
            .iter()
            .any(|template| template.contains("SessionId must be a string"))
    );
    let corpus = [
        HARNESS_SESSION_ID,
        ERRORS,
        PROVIDER,
        TASK,
        TASK_RESULT,
        EVENTS,
        MESSAGE,
        CHANNEL,
        HOOKS,
        TOOL,
    ]
    .join("\n");
    for template in &templates {
        for fragment in fragments(template) {
            assert!(
                corpus.contains(&fragment),
                "missing protocol fragment {fragment:?} from {template:?}"
            );
        }
    }
}

fn message_templates(source: &str) -> Vec<String> {
    rust_strings(source)
        .into_iter()
        .filter(|text| text.chars().any(|ch| ch.is_whitespace() || !ch.is_ascii()))
        .filter(|text| text.chars().count() >= 4)
        .collect()
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
