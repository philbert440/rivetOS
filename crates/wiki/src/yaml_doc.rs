use std::collections::HashSet;
use std::fmt;

use serde::Deserialize;
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};

use crate::error::WikiParseError;
use crate::model::Passthrough;

const LINE_WIDTH: i32 = 80;
const MIN_CONTENT_WIDTH: usize = 20;
const DOUBLE_QUOTE_MIN_MULTI: usize = 40;

pub(crate) fn parse_yaml_value(text: &str) -> Result<Passthrough, WikiParseError> {
    let options = serde_saphyr::Options {
        strict_booleans: true,
        ..serde_saphyr::Options::default()
    };
    let marked: Marked = serde_saphyr::from_str_with_options(text, options).map_err(|err| {
        let detail = err.to_string();
        if detail.is_empty() {
            WikiParseError::new("invalid YAML frontmatter")
        } else {
            WikiParseError::new(detail)
        }
    })?;
    Ok(lower(text, &marked))
}

pub(crate) fn emit_yaml(value: &Passthrough) -> String {
    let body = emit_value(value, &EmitCtx::root());
    format!("{body}\n")
}

#[derive(Clone)]
struct EmitCtx {
    indent: String,
    implicit_key: bool,
    in_flow: bool,
    indent_at_start: Option<usize>,
}

impl EmitCtx {
    fn root() -> Self {
        Self {
            indent: String::new(),
            implicit_key: false,
            in_flow: false,
            indent_at_start: None,
        }
    }

    fn child(&self, indent: String) -> Self {
        Self {
            indent,
            implicit_key: false,
            in_flow: false,
            indent_at_start: None,
        }
    }
}

fn emit_value(value: &Passthrough, ctx: &EmitCtx) -> String {
    match value.js() {
        protocol::js::JsValue::Null => "null".to_string(),
        protocol::js::JsValue::Bool(true) => "true".to_string(),
        protocol::js::JsValue::Bool(false) => "false".to_string(),
        protocol::js::JsValue::Number(number) => format_yaml_number(*number),
        protocol::js::JsValue::String(text) => emit_string(text.to_utf8(), ctx),
        protocol::js::JsValue::Array(items) => {
            let docs: Vec<Passthrough> = items.iter().cloned().map(Passthrough::from_js).collect();
            emit_seq(&docs, ctx)
        }
        protocol::js::JsValue::Object(object) => {
            let entries: Vec<(String, Passthrough)> = object
                .iter()
                .map(|(key, item)| {
                    (
                        key.to_utf8().to_string(),
                        Passthrough::from_js(item.clone()),
                    )
                })
                .collect();
            emit_map(&entries, ctx)
        }
    }
}

fn format_yaml_number(value: f64) -> String {
    if value.is_nan() {
        return ".nan".to_string();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-.inf".to_string()
        } else {
            ".inf".to_string()
        };
    }
    if value == 0.0 && value.is_sign_negative() {
        return "-0".to_string();
    }
    protocol::JsNumber::from(value).to_string()
}

fn emit_string(value: &str, ctx: &EmitCtx) -> String {
    if forces_double(value) {
        return double_quoted(value, ctx);
    }
    plain_string(value, ctx)
}

fn forces_double(value: &str) -> bool {
    value.chars().any(|ch| {
        let unit = ch as u32;
        unit <= 0x08 || (0x0b..=0x1f).contains(&unit) || (0x7f..=0x9f).contains(&unit)
    })
}

fn plain_string(value: &str, ctx: &EmitCtx) -> String {
    if (ctx.implicit_key && value.contains('\n'))
        || (ctx.in_flow
            && value
                .chars()
                .any(|ch| matches!(ch, '[' | ']' | '{' | '}' | ',')))
    {
        return quoted_string(value, ctx);
    }
    if plain_forbidden(value) {
        if ctx.implicit_key || ctx.in_flow || !value.contains('\n') {
            return quoted_string(value, ctx);
        }
        return block_string(value, ctx);
    }
    if !ctx.implicit_key && !ctx.in_flow && value.contains('\n') {
        return block_string(value, ctx);
    }
    if contains_document_marker(value) {
        if ctx.indent.is_empty() {
            return block_string(value, ctx);
        }
        if ctx.implicit_key && ctx.indent == "  " {
            return quoted_string(value, ctx);
        }
    }
    if ambiguous_plain(value) {
        return quoted_string(value, ctx);
    }
    if ctx.implicit_key {
        value.to_string()
    } else {
        fold_flow_lines(value, &ctx.indent, FoldMode::Flow, ctx.indent_at_start).0
    }
}

fn plain_forbidden(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if matches!(
        first,
        '\n' | '\t'
            | ' '
            | ','
            | '['
            | ']'
            | '{'
            | '}'
            | '#'
            | '&'
            | '*'
            | '!'
            | '|'
            | '>'
            | '\''
            | '"'
            | '%'
            | '@'
            | '`'
    ) {
        return true;
    }
    if value == "?" || value == "-" {
        return true;
    }
    if matches!(first, '?' | '-') && matches!(chars.next(), Some(' ' | '\t')) {
        return true;
    }
    let chars: Vec<char> = value.chars().collect();
    for index in 0..chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if matches!(ch, '\n' | ':') && matches!(next, Some(' ' | '\t')) {
            return true;
        }
        if matches!(ch, ' ' | '\t') && next == Some('\n') {
            return true;
        }
        if matches!(ch, '\n' | '\t' | ' ') && next == Some('#') {
            return true;
        }
    }
    matches!(chars.last().copied(), Some(' ' | '\t' | '\n' | ':'))
}

fn contains_document_marker(value: &str) -> bool {
    value
        .lines()
        .any(|line| line.starts_with('%') || line.starts_with("---") || line.starts_with("..."))
        || value.ends_with('\n')
            && (value.ends_with("%\n") || value.ends_with("---\n") || value.ends_with("...\n"))
}

fn ambiguous_plain(value: &str) -> bool {
    null_plain(value)
        || bool_plain(value)
        || int_plain(value)
        || oct_plain(value)
        || hex_plain(value)
        || float_nan_plain(value)
        || float_exp_plain(value)
        || float_plain(value)
}

fn null_plain(value: &str) -> bool {
    value.is_empty()
        || value == "~"
        || value.eq_ignore_ascii_case("null")
            && (value == "null" || value == "Null" || value == "NULL")
}

fn bool_plain(value: &str) -> bool {
    matches!(
        value,
        "true" | "True" | "TRUE" | "false" | "False" | "FALSE"
    )
}

fn int_plain(value: &str) -> bool {
    let bytes = value.as_bytes();
    let rest = match bytes.first() {
        Some(b'+' | b'-') => &bytes[1..],
        _ => bytes,
    };
    !rest.is_empty() && rest.iter().all(u8::is_ascii_digit)
}

fn oct_plain(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("0o") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|byte| matches!(byte, b'0'..=b'7'))
}

fn hex_plain(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("0x") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn float_nan_plain(value: &str) -> bool {
    matches!(
        value,
        ".inf"
            | ".Inf"
            | ".INF"
            | "-.inf"
            | "-.Inf"
            | "-.INF"
            | "+.inf"
            | "+.Inf"
            | "+.INF"
            | ".nan"
            | ".NaN"
            | ".NAN"
    )
}

fn float_exp_plain(value: &str) -> bool {
    let bytes = strip_sign(value.as_bytes());
    let Some(exp) = bytes.iter().position(|byte| matches!(byte, b'e' | b'E')) else {
        return false;
    };
    if exp == 0 {
        return false;
    }
    let mantissa = &bytes[..exp];
    let exponent = &bytes[exp + 1..];
    mantissa_plain(mantissa) && exponent_plain(exponent)
}

fn float_plain(value: &str) -> bool {
    let bytes = strip_sign(value.as_bytes());
    if bytes.iter().any(|byte| matches!(byte, b'e' | b'E')) {
        return false;
    }
    let Some(dot) = bytes.iter().position(|byte| *byte == b'.') else {
        return false;
    };
    let whole = &bytes[..dot];
    let frac = &bytes[dot + 1..];
    let whole_ok = !whole.is_empty() && whole.iter().all(u8::is_ascii_digit);
    let frac_ok = frac.iter().all(u8::is_ascii_digit);
    if whole.is_empty() {
        return !frac.is_empty() && frac_ok;
    }
    whole_ok && frac_ok
}

fn strip_sign(bytes: &[u8]) -> &[u8] {
    match bytes.first() {
        Some(b'+' | b'-') => &bytes[1..],
        _ => bytes,
    }
}

fn mantissa_plain(bytes: &[u8]) -> bool {
    if let Some(dot) = bytes.iter().position(|byte| *byte == b'.') {
        let whole = &bytes[..dot];
        let frac = &bytes[dot + 1..];
        let whole_ok = whole.iter().all(u8::is_ascii_digit);
        let frac_ok = frac.iter().all(u8::is_ascii_digit);
        if whole.is_empty() {
            return !frac.is_empty() && frac_ok;
        }
        return whole_ok && frac_ok && (!frac.is_empty() || !whole.is_empty());
    }
    !bytes.is_empty() && bytes.iter().all(u8::is_ascii_digit)
}

fn exponent_plain(bytes: &[u8]) -> bool {
    let rest = strip_sign(bytes);
    !rest.is_empty() && rest.iter().all(u8::is_ascii_digit)
}

fn quoted_string(value: &str, ctx: &EmitCtx) -> String {
    let has_double = value.contains('"');
    let has_single = value.contains('\'');
    if has_double && !has_single {
        single_quoted(value, ctx)
    } else {
        double_quoted(value, ctx)
    }
}

fn double_quoted(value: &str, ctx: &EmitCtx) -> String {
    let indent = quote_indent(value, ctx);
    let json = json_string(value);
    let folded = finish_double_quoted(&json, ctx, &indent);
    if ctx.implicit_key {
        folded
    } else {
        fold_flow_lines(&folded, &indent, FoldMode::Quoted, ctx.indent_at_start).0
    }
}

fn quote_indent(value: &str, ctx: &EmitCtx) -> String {
    if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if contains_document_marker(value) {
        "  ".to_string()
    } else {
        String::new()
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn finish_double_quoted(json: &str, ctx: &EmitCtx, indent: &str) -> String {
    let units: Vec<u16> = json.encode_utf16().collect();
    let mut out: Vec<u16> = Vec::new();
    let mut start = 0usize;
    let mut i = 0isize;
    while i >= 0 && (i as usize) < units.len() {
        let mut ch = units[i as usize];
        if ch == u16::from(b' ') && unit_is(&units, i + 1, b'\\') && unit_is(&units, i + 2, b'n') {
            out.extend_from_slice(&units[start..i as usize]);
            out.push(u16::from(b'\\'));
            out.push(u16::from(b' '));
            i += 1;
            start = i as usize;
            ch = u16::from(b'\\');
        }
        if ch == u16::from(b'\\') {
            match unit_at(&units, i + 1) {
                Some(code) if code == u16::from(b'u') => {
                    out.extend_from_slice(&units[start..i as usize]);
                    let code = units_slice(&units, (i + 2) as usize, (i + 6) as usize);
                    out.extend(yaml_u_escape(&code).encode_utf16());
                    i += 5;
                    start = (i + 1) as usize;
                }
                Some(code) if code == u16::from(b'n') => {
                    let short = ctx.implicit_key
                        || unit_is(&units, i + 2, b'"')
                        || units.len() < DOUBLE_QUOTE_MIN_MULTI;
                    if short {
                        i += 1;
                    } else {
                        out.extend_from_slice(&units[start..i as usize]);
                        out.push(u16::from(b'\n'));
                        out.push(u16::from(b'\n'));
                        while unit_is(&units, i + 2, b'\\')
                            && unit_is(&units, i + 3, b'n')
                            && !unit_is(&units, i + 4, b'"')
                        {
                            out.push(u16::from(b'\n'));
                            i += 2;
                        }
                        out.extend(indent.encode_utf16());
                        if unit_is(&units, i + 2, b' ') {
                            out.push(u16::from(b'\\'));
                        }
                        i += 1;
                        start = (i + 1) as usize;
                    }
                }
                _ => {
                    i += 1;
                }
            }
        }
        i += 1;
    }
    if start == 0 {
        json.to_string()
    } else {
        out.extend_from_slice(&units[start.min(units.len())..]);
        units_to_string(&out)
    }
}

fn yaml_u_escape(code: &str) -> String {
    match code {
        "0000" => "\\0".to_string(),
        "0007" => "\\a".to_string(),
        "000b" => "\\v".to_string(),
        "001b" => "\\e".to_string(),
        "0085" => "\\N".to_string(),
        "00a0" => "\\_".to_string(),
        "2028" => "\\L".to_string(),
        "2029" => "\\P".to_string(),
        _ if code.len() == 4 && code.starts_with("00") => format!("\\x{}", &code[2..]),
        _ => format!("\\u{code}"),
    }
}

fn unit_at(units: &[u16], index: isize) -> Option<u16> {
    if index < 0 {
        None
    } else {
        units.get(index as usize).copied()
    }
}

fn unit_is(units: &[u16], index: isize, byte: u8) -> bool {
    unit_at(units, index) == Some(u16::from(byte))
}

fn units_slice(units: &[u16], start: usize, end: usize) -> String {
    let end = end.min(units.len());
    let start = start.min(end);
    units_to_string(&units[start..end])
}

fn units_to_string(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|item| item.unwrap_or('\u{FFFD}'))
        .collect()
}

fn single_quoted(value: &str, ctx: &EmitCtx) -> String {
    if (ctx.implicit_key && value.contains('\n')) || single_quote_blocked(value) {
        return double_quoted(value, ctx);
    }
    let indent = quote_indent(value, ctx);
    let escaped = value.replace('\'', "''");
    let body = indent_single_newlines(&escaped, &indent);
    let quoted = format!("'{body}'");
    if ctx.implicit_key {
        quoted
    } else {
        fold_flow_lines(&quoted, &indent, FoldMode::Flow, ctx.indent_at_start).0
    }
}

fn single_quote_blocked(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    for index in 0..chars.len().saturating_sub(1) {
        let ch = chars[index];
        let next = chars[index + 1];
        if matches!(ch, ' ' | '\t') && next == '\n' {
            return true;
        }
        if ch == '\n' && matches!(next, ' ' | '\t') {
            return true;
        }
    }
    false
}

fn indent_single_newlines(value: &str, indent: &str) -> String {
    let mut out = String::new();
    let bytes = value.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let start = index;
            index += 1;
            while index < bytes.len() && bytes[index] == b'\n' {
                index += 1;
            }
            out.push_str(&value[start..index]);
            out.push('\n');
            out.push_str(indent);
        } else {
            let ch = value[index..].chars().next().unwrap_or('\u{FFFD}');
            out.push(ch);
            index += ch.len_utf8();
        }
    }
    out
}

fn block_string(value: &str, ctx: &EmitCtx) -> String {
    if trailing_blank_line(value) {
        return quoted_string(value, ctx);
    }
    let mut indent = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if contains_document_marker(value) {
        "  ".to_string()
    } else {
        String::new()
    };
    if ctx.indent.is_empty() && contains_document_marker(value) {
        indent = "  ".to_string();
    }
    let literal = !line_length_over_limit(value, LINE_WIDTH, indent.len());
    if value.is_empty() {
        return if literal {
            "|\n".to_string()
        } else {
            ">\n".to_string()
        };
    }
    let (chomp, mut head, end) = chomp_tail(value);
    let (start_with_space, start, rest) = split_block_start(&head);
    head = rest;
    let indent_size = if start_with_space {
        if indent.is_empty() { "1" } else { "2" }
    } else {
        ""
    };
    let header = format!("{indent_size}{chomp}");
    if !literal {
        let folded_value = fold_block_body(&head, &indent);
        let combined = format!(
            "{}{}{}",
            indent_after_newlines(&start, &indent),
            folded_value,
            end
        );
        let (body, overflow) =
            fold_flow_lines(&combined, &indent, FoldMode::Block, Some(indent.len()));
        if !overflow {
            return format!(">{header}\n{indent}{body}");
        }
    }
    let start = indent_after_newlines(&start, &indent);
    let body = indent_after_newlines(&head, &indent);
    format!("|{header}\n{indent}{start}{body}{end}")
}

fn trailing_blank_line(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = bytes.len();
    let mut saw = false;
    while index > 0 && matches!(bytes[index - 1], b' ' | b'\t') {
        saw = true;
        index -= 1;
    }
    saw && index > 0 && bytes[index - 1] == b'\n'
}

fn chomp_tail(value: &str) -> (String, String, String) {
    let bytes = value.as_bytes();
    let mut end_start = bytes.len();
    while end_start > 0 && matches!(bytes[end_start - 1], b'\n' | b'\t' | b' ') {
        end_start -= 1;
    }
    let mut end = value[end_start..].to_string();
    let chomp = match end.find('\n') {
        None => "-".to_string(),
        Some(pos) if value == end || pos != end.len() - 1 => "+".to_string(),
        Some(_) => String::new(),
    };
    let head = value[..end_start].to_string();
    if !end.is_empty() {
        if end.ends_with('\n') {
            end.pop();
        }
        end = indent_newlines_not_at_end(&end, "");
    }
    (chomp, head, end)
}

fn split_block_start(value: &str) -> (bool, String, String) {
    let bytes = value.as_bytes();
    let mut start_with_space = false;
    let mut start_nl: Option<usize> = None;
    let mut start_end = 0usize;
    while start_end < bytes.len() {
        match bytes[start_end] {
            b' ' => {
                start_with_space = true;
                start_end += 1;
            }
            b'\n' => {
                start_nl = Some(start_end);
                start_end += 1;
            }
            _ => break,
        }
    }
    let cut = if let Some(pos) = start_nl {
        if pos < start_end { pos + 1 } else { start_end }
    } else {
        0
    };
    (
        start_with_space,
        value[..cut].to_string(),
        value[cut..].to_string(),
    )
}

fn indent_after_newlines(value: &str, indent: &str) -> String {
    if indent.is_empty() || !value.contains('\n') {
        return value.to_string();
    }
    let mut out = String::new();
    let bytes = value.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let start = index;
            index += 1;
            while index < bytes.len() && bytes[index] == b'\n' {
                index += 1;
            }
            out.push_str(&value[start..index]);
            out.push_str(indent);
        } else {
            let ch = value[index..].chars().next().unwrap_or('\u{FFFD}');
            out.push(ch);
            index += ch.len_utf8();
        }
    }
    out
}

fn indent_newlines_not_at_end(value: &str, indent: &str) -> String {
    if !value.contains('\n') {
        return value.to_string();
    }
    let mut out = String::new();
    let bytes = value.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let start = index;
            index += 1;
            while index < bytes.len() && bytes[index] == b'\n' {
                index += 1;
            }
            out.push_str(&value[start..index]);
            if index < bytes.len() {
                out.push_str(indent);
            }
        } else {
            let ch = value[index..].chars().next().unwrap_or('\u{FFFD}');
            out.push(ch);
            index += ch.len_utf8();
        }
    }
    out
}

fn fold_block_body(value: &str, indent: &str) -> String {
    let doubled = indent_single_newlines(value, "");
    let kept = fold_more_indented(&doubled);
    indent_after_newlines(&kept, indent)
}

fn fold_more_indented(value: &str) -> String {
    let mut out = String::new();
    let lines: Vec<&str> = split_keep_ends(value);
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        let content = line.trim_end_matches(['\n', '\r']);
        let more = content.starts_with(' ') || content.starts_with('\t');
        if more {
            out.push_str(content);
            index += 1;
            let mut blanks = String::new();
            while index < lines.len() {
                let next = lines[index].trim_end_matches(['\n', '\r']);
                if next.is_empty() || next.starts_with(' ') || next.starts_with('\t') {
                    if lines[index].contains('\n') {
                        blanks.push('\n');
                    }
                    if !next.is_empty() && (next.starts_with(' ') || next.starts_with('\t')) {
                        out.push_str(&blanks);
                        blanks.clear();
                        out.push_str(next);
                    }
                    index += 1;
                } else {
                    break;
                }
            }
            out.push_str(&blanks);
        } else {
            out.push_str(line);
            index += 1;
        }
    }
    out
}

fn split_keep_ends(value: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            lines.push(&value[start..=index]);
            start = index + 1;
        }
    }
    if start < value.len() {
        lines.push(&value[start..]);
    }
    lines
}

fn line_length_over_limit(value: &str, line_width: i32, indent_len: usize) -> bool {
    if line_width <= 0 {
        return false;
    }
    let limit = line_width as usize - indent_len.min(line_width as usize);
    let units: Vec<u16> = value.encode_utf16().collect();
    if units.len() <= limit {
        return false;
    }
    let mut start = 0usize;
    for (index, unit) in units.iter().enumerate() {
        if *unit == u16::from(b'\n') {
            if index - start > limit {
                return true;
            }
            start = index + 1;
            if units.len() - start <= limit {
                return false;
            }
        }
    }
    true
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FoldMode {
    Flow,
    Block,
    Quoted,
}

fn fold_flow_lines(
    text: &str,
    indent: &str,
    mode: FoldMode,
    block_indent_at_start: Option<usize>,
) -> (String, bool) {
    if LINE_WIDTH <= 0 {
        return (text.to_string(), false);
    }
    let mut min_content = MIN_CONTENT_WIDTH;
    if LINE_WIDTH < min_content as i32 {
        min_content = 0;
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let indent_len = indent.encode_utf16().count();
    let end_step = (1 + min_content).max(1 + (LINE_WIDTH as usize).saturating_sub(indent_len));
    if units.len() <= end_step {
        return (text.to_string(), false);
    }
    let mut folds = Vec::new();
    let mut escaped = HashSet::new();
    let mut end = LINE_WIDTH as isize - indent_len as isize;
    if let Some(indent_at_start) = block_indent_at_start {
        if indent_at_start as i32 > LINE_WIDTH - (2.max(min_content as i32)) {
            folds.push(0isize);
        } else {
            end = LINE_WIDTH as isize - indent_at_start as isize;
        }
    }
    let mut split: Option<isize> = None;
    let mut prev: Option<u16> = None;
    let mut overflow = false;
    let mut i = -1isize;
    let mut esc_start = -1isize;
    let mut esc_end = -1isize;
    if mode == FoldMode::Block {
        i = consume_more_indented_lines(&units, i, indent_len);
        if i != -1 {
            end = i + end_step as isize;
        }
    }
    loop {
        i += 1;
        let Some(mut ch) = unit_at(&units, i) else {
            break;
        };
        if ch == 0 {
            break;
        }
        if mode == FoldMode::Quoted && ch == u16::from(b'\\') {
            esc_start = i;
            match unit_at(&units, i + 1) {
                Some(next) if next == u16::from(b'x') => i += 3,
                Some(next) if next == u16::from(b'u') => i += 5,
                Some(next) if next == u16::from(b'U') => i += 9,
                _ => i += 1,
            }
            esc_end = i;
        }
        if ch == u16::from(b'\n') {
            if mode == FoldMode::Block {
                i = consume_more_indented_lines(&units, i, indent_len);
            }
            end = i + indent_len as isize + end_step as isize;
            split = None;
        } else {
            if ch == u16::from(b' ')
                && prev.is_some_and(|prev| {
                    prev != u16::from(b' ') && prev != u16::from(b'\n') && prev != u16::from(b'\t')
                })
                && let Some(next) = unit_at(&units, i + 1)
                && next != u16::from(b' ')
                && next != u16::from(b'\n')
                && next != u16::from(b'\t')
            {
                split = Some(i);
            }
            if i >= end {
                if let Some(at) = split {
                    folds.push(at);
                    end = at + end_step as isize;
                    split = None;
                } else if mode == FoldMode::Quoted {
                    while prev == Some(u16::from(b' ')) || prev == Some(u16::from(b'\t')) {
                        prev = Some(ch);
                        i += 1;
                        match unit_at(&units, i) {
                            Some(next) => ch = next,
                            None => break,
                        }
                        overflow = true;
                    }
                    let j = if i > esc_end + 1 {
                        i - 2
                    } else {
                        esc_start - 1
                    };
                    if escaped.contains(&j) {
                        return (text.to_string(), overflow);
                    }
                    folds.push(j);
                    escaped.insert(j);
                    end = j + end_step as isize;
                    split = None;
                } else {
                    overflow = true;
                }
            }
        }
        prev = Some(ch);
    }
    if folds.is_empty() {
        return (text.to_string(), overflow);
    }
    let mut res = units_slice(&units, 0, folds[0].max(0) as usize);
    for index in 0..folds.len() {
        let fold = folds[index];
        let next = folds
            .get(index + 1)
            .copied()
            .unwrap_or(units.len() as isize);
        if fold == 0 {
            res = format!("\n{indent}{}", units_slice(&units, 0, next.max(0) as usize));
        } else {
            if mode == FoldMode::Quoted && escaped.contains(&fold) {
                if let Some(ch) = unit_at(&units, fold) {
                    res.push(char::from_u32(u32::from(ch)).unwrap_or('\u{FFFD}'));
                }
                res.push('\\');
            }
            let from = (fold + 1).max(0) as usize;
            let to = next.max(0) as usize;
            res.push('\n');
            res.push_str(indent);
            res.push_str(&units_slice(&units, from, to));
        }
    }
    (res, overflow)
}

fn consume_more_indented_lines(units: &[u16], mut i: isize, indent: usize) -> isize {
    let mut end = i;
    let mut start = i + 1;
    let mut ch = unit_at(units, start);
    while matches!(ch, Some(unit) if unit == u16::from(b' ') || unit == u16::from(b'\t')) {
        if (i as usize) < (start as usize) + indent {
            i += 1;
            ch = unit_at(units, i);
        } else {
            loop {
                i += 1;
                ch = unit_at(units, i);
                if ch.is_none() || ch == Some(u16::from(b'\n')) {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = unit_at(units, start);
        }
    }
    end
}

fn emit_seq(items: &[Passthrough], ctx: &EmitCtx) -> String {
    if items.is_empty() {
        return "[]".to_string();
    }
    let item_indent = format!("{}  ", ctx.indent);
    let mut lines = Vec::new();
    for item in items {
        let item_ctx = ctx.child(item_indent.clone());
        let text = emit_value(item, &item_ctx);
        lines.push(format!("- {text}"));
    }
    join_block_lines(&lines, &ctx.indent)
}

fn emit_map(map: &[(String, Passthrough)], ctx: &EmitCtx) -> String {
    if map.is_empty() {
        return "{}".to_string();
    }
    let mut lines = Vec::new();
    for (key, value) in map {
        lines.push(emit_pair(key, value, ctx));
    }
    join_block_lines(&lines, &ctx.indent)
}

fn join_block_lines(lines: &[String], indent: &str) -> String {
    let mut out = lines.first().cloned().unwrap_or_default();
    for line in lines.iter().skip(1) {
        out.push('\n');
        if !line.is_empty() {
            out.push_str(indent);
            out.push_str(line);
        }
    }
    out
}

fn emit_pair(key: &str, value: &Passthrough, ctx: &EmitCtx) -> String {
    let key_ctx = EmitCtx {
        indent: format!("{}  ", ctx.indent),
        implicit_key: true,
        in_flow: false,
        indent_at_start: None,
    };
    let key_str = emit_string(key, &key_ctx);
    let mut line = format!("{key_str}:");
    let mut value_ctx = key_ctx;
    value_ctx.implicit_key = false;
    let scalar = !is_collection(value);
    if scalar {
        value_ctx.indent_at_start = Some(line.encode_utf16().count() + 1);
    }
    let saved_indent = value_ctx.indent.clone();
    let value_str = emit_value(value, &value_ctx);
    let ws = pair_separator(value, &value_str, &saved_indent);
    line.push_str(&ws);
    line.push_str(&value_str);
    line
}

fn is_collection(value: &Passthrough) -> bool {
    matches!(
        value.js(),
        protocol::js::JsValue::Array(_) | protocol::js::JsValue::Object(_)
    )
}

fn is_empty_collection(value: &Passthrough) -> bool {
    match value.js() {
        protocol::js::JsValue::Array(items) => items.is_empty(),
        protocol::js::JsValue::Object(object) => object.is_empty(),
        _ => false,
    }
}

fn pair_separator(value: &Passthrough, value_str: &str, indent: &str) -> String {
    if is_collection(value) {
        if value_str.contains('\n') || !is_empty_collection(value) {
            format!("\n{indent}")
        } else {
            " ".to_string()
        }
    } else if value_str.is_empty() || value_str.starts_with('\n') {
        String::new()
    } else {
        " ".to_string()
    }
}

struct Marked {
    provisional: Provisional,
    span: serde_saphyr::Span,
}

enum Provisional {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Marked>),
    Object(Vec<(String, Marked)>),
}

impl<'de> Deserialize<'de> for Marked {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let spanned = serde_saphyr::Spanned::<Provisional>::deserialize(deserializer)?;
        Ok(Self {
            provisional: spanned.value,
            span: spanned.defined.span(),
        })
    }
}

impl<'de> Deserialize<'de> for Provisional {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(ProvisionalVisitor)
    }
}

struct ProvisionalVisitor;

impl<'de> Visitor<'de> for ProvisionalVisitor {
    type Value = Provisional;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a YAML value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Provisional::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Provisional::Null)
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Provisional::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Provisional::Number(value as f64))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Provisional::Number(value as f64))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        Ok(Provisional::Number(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Provisional::String(value.to_string()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(Provisional::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<Marked>()? {
            items.push(item);
        }
        Ok(Provisional::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut entries = Vec::new();
        while let Some((key, value)) = map.next_entry::<String, Marked>()? {
            entries.push((key, value));
        }
        Ok(Provisional::Object(entries))
    }
}

fn lower(text: &str, node: &Marked) -> Passthrough {
    match &node.provisional {
        Provisional::Null => Passthrough::null(),
        Provisional::Bool(value) => Passthrough::bool(*value),
        Provisional::Number(value) => Passthrough::number(signed_zero(text, *value, node.span)),
        Provisional::String(value) => match nonfinite_number(text, value, node.span) {
            Some(number) => Passthrough::number(number),
            None => Passthrough::string(value),
        },
        Provisional::Array(items) => {
            Passthrough::array(items.iter().map(|item| lower(text, item)).collect())
        }
        Provisional::Object(entries) => {
            let mut object = protocol::js::JsObject::new();
            for (key, value) in entries {
                object.insert(key.clone(), lower(text, value).into_js());
            }
            Passthrough::from_object(object)
        }
    }
}

fn signed_zero(text: &str, value: f64, span: serde_saphyr::Span) -> f64 {
    if value != 0.0 || value.is_sign_negative() {
        return value;
    }
    let Some(slice) = source_slice(text, span) else {
        return value;
    };
    if slice.trim().starts_with('-') {
        -0.0
    } else {
        value
    }
}

fn nonfinite_number(text: &str, literal: &str, span: serde_saphyr::Span) -> Option<f64> {
    let number = match literal {
        ".nan" => f64::NAN,
        ".inf" => f64::INFINITY,
        "-.inf" => f64::NEG_INFINITY,
        _ => return None,
    };
    if quoted_or_block(text, span) {
        None
    } else {
        Some(number)
    }
}

fn quoted_or_block(text: &str, span: serde_saphyr::Span) -> bool {
    let Some(slice) = source_slice(text, span) else {
        return false;
    };
    let trimmed = slice.trim();
    if trimmed.starts_with(['"', '\'', '|', '>']) || slice.contains('\n') {
        return true;
    }
    quote_before(text, span.offset()) || block_header_before(text, span.offset())
}

fn quote_before(text: &str, offset: usize) -> bool {
    matches!(text.chars().take(offset).last(), Some('"' | '\''))
}

fn block_header_before(text: &str, offset: usize) -> bool {
    let chars: Vec<char> = text.chars().take(offset).collect();
    let mut end = chars.len();
    while end > 0 && is_yaml_space(chars[end - 1]) {
        end -= 1;
    }
    if end == 0 {
        return false;
    }
    let mut line_start = end;
    while line_start > 0 && !is_line_break(chars[line_start - 1]) {
        line_start -= 1;
    }
    end = line_start + comment_trimmed_end(&chars[line_start..end]);
    if end <= line_start {
        return false;
    }
    let mut start = end;
    let mut taken = 0usize;
    while start > line_start && taken < 3 && !is_yaml_space(chars[start - 1]) {
        start -= 1;
        taken += 1;
    }
    is_block_header(&chars[start..end])
}

fn is_line_break(ch: char) -> bool {
    matches!(ch, '\n' | '\r')
}

fn comment_trimmed_end(line: &[char]) -> usize {
    let mut index = 0usize;
    let mut quote: Option<char> = None;
    while index < line.len() {
        let ch = line[index];
        if quote == Some('\'') {
            if ch == '\'' {
                if line.get(index + 1) == Some(&'\'') {
                    index += 2;
                    continue;
                }
                quote = None;
            }
            index += 1;
            continue;
        }
        if quote == Some('"') {
            if ch == '\\' {
                index += 1;
                if index < line.len() {
                    index += 1;
                }
                continue;
            }
            if ch == '"' {
                quote = None;
            }
            index += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            index += 1;
            continue;
        }
        if ch == '#' && index > 0 && is_yaml_space(line[index - 1]) {
            let mut end = index;
            while end > 0 && is_yaml_space(line[end - 1]) {
                end -= 1;
            }
            return end;
        }
        index += 1;
    }
    let mut end = line.len();
    while end > 0 && is_yaml_space(line[end - 1]) {
        end -= 1;
    }
    end
}

fn is_yaml_space(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r')
}

fn is_block_header(chars: &[char]) -> bool {
    let text: String = chars.iter().collect();
    let bytes = text.as_bytes();
    if bytes
        .first()
        .is_none_or(|byte| !matches!(byte, b'|' | b'>'))
    {
        return false;
    }
    matches!(
        &bytes[1..],
        [] | [b'-' | b'+']
            | [b'1'..=b'9']
            | [b'-' | b'+', b'1'..=b'9']
            | [b'1'..=b'9', b'-' | b'+']
    )
}

fn source_slice(text: &str, span: serde_saphyr::Span) -> Option<&str> {
    let offset = span.offset();
    let end_index = offset.saturating_add(span.len());
    let mut start_byte = None;
    let mut end_byte = None;
    for (index, (byte, _)) in text.char_indices().enumerate() {
        if index == offset {
            start_byte = Some(byte);
        }
        if index == end_index {
            end_byte = Some(byte);
            break;
        }
    }
    let start = start_byte?;
    let end = end_byte.unwrap_or(text.len());
    if end < start || end > text.len() {
        return None;
    }
    Some(&text[start..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_yaml_stringify_golden() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../tests/golden/stringify.json")).expect("golden");
        let cases = golden.get("cases").expect("cases");
        for case in cases
            .get("strings")
            .and_then(serde_json::Value::as_array)
            .expect("strings")
        {
            let input = case.get("input").expect("input");
            let output = case
                .get("output")
                .and_then(serde_json::Value::as_str)
                .expect("output");
            let doc = Passthrough::object([("value", Passthrough::from_json(input))]);
            assert_eq!(emit_yaml(&doc), output, "{input}");
        }
        for case in cases
            .get("arrays")
            .and_then(serde_json::Value::as_array)
            .expect("arrays")
        {
            let input = case.get("input").expect("input");
            let output = case
                .get("output")
                .and_then(serde_json::Value::as_str)
                .expect("output");
            let doc = Passthrough::object([("list", Passthrough::from_json(input))]);
            assert_eq!(emit_yaml(&doc), output, "{input}");
        }
        for case in cases
            .get("nested")
            .and_then(serde_json::Value::as_array)
            .expect("nested")
        {
            let input = case.get("input").expect("input");
            let output = case
                .get("output")
                .and_then(serde_json::Value::as_str)
                .expect("output");
            assert_eq!(emit_yaml(&Passthrough::from_json(input)), output);
        }
        let numbers = [
            0.0,
            -0.0,
            1.0,
            1.5,
            1e21,
            123456789012345680000.0,
            f64::NAN,
            f64::INFINITY,
        ];
        let recorded = cases
            .get("numbers")
            .and_then(serde_json::Value::as_array)
            .expect("numbers");
        for (index, value) in numbers.iter().enumerate() {
            let output = recorded[index]
                .get("output")
                .and_then(serde_json::Value::as_str)
                .expect("output");
            assert_eq!(
                format!("n: {}\n", format_yaml_number(*value)),
                output,
                "{index}"
            );
            let doc = Passthrough::object([("n", Passthrough::number(*value))]);
            assert_eq!(emit_yaml(&doc), output, "emit {index}");
        }
    }

    #[test]
    fn plain_nonfinite_is_a_number_and_quoted_nonfinite_is_a_string() {
        let nan = parse_yaml_value("metric: .nan\n").expect("nan");
        assert!(
            nan.get("metric")
                .as_ref()
                .and_then(Passthrough::as_f64)
                .expect("number")
                .is_nan()
        );
        assert_eq!(emit_yaml(&nan), "metric: .nan\n");
        let quoted = parse_yaml_value("metric: \".nan\"\n").expect("quoted");
        assert_eq!(
            quoted.get("metric").as_ref().and_then(Passthrough::as_str),
            Some(".nan")
        );
        let inf = parse_yaml_value("metric: .inf\n").expect("inf");
        assert_eq!(
            inf.get("metric").as_ref().and_then(Passthrough::as_f64),
            Some(f64::INFINITY)
        );
        let neg = parse_yaml_value("metric: -.inf\n").expect("neg");
        assert_eq!(
            neg.get("metric").as_ref().and_then(Passthrough::as_f64),
            Some(f64::NEG_INFINITY)
        );
        let neg_zero = parse_yaml_value("n: -0.0\n").expect("neg zero");
        let zero = neg_zero
            .get("n")
            .as_ref()
            .and_then(Passthrough::as_f64)
            .expect("zero");
        assert!(zero == 0.0 && zero.is_sign_negative());
        assert_eq!(emit_yaml(&neg_zero), "n: -0\n");
        let again = parse_yaml_value("n: -0\n").expect("signed zero");
        let signed = again
            .get("n")
            .as_ref()
            .and_then(Passthrough::as_f64)
            .expect("signed");
        assert!(signed == 0.0 && signed.is_sign_negative());
        assert_eq!(emit_yaml(&again), "n: -0\n");
    }
}
