use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::fsutil::{self, lossy};
use crate::value::{Obj, jtrim};

#[derive(Clone)]
pub struct ParsedLine {
    pub index: usize,
    pub offset: u64,
    pub value: Value,
}

pub struct JsonlFile {
    pub lines: Vec<ParsedLine>,
    pub objects: Vec<Obj>,
    pub truncated: bool,
    pub text: String,
}

impl JsonlFile {
    pub fn empty() -> Self {
        Self {
            lines: Vec::new(),
            objects: Vec::new(),
            truncated: false,
            text: String::new(),
        }
    }
}

pub fn read_jsonl(path: &Path, max_bytes: u64) -> JsonlFile {
    let Some(size) = fsutil::file_len(path) else {
        return JsonlFile::empty();
    };
    let (text, truncated) = if size > max_bytes {
        let start = size - max_bytes;
        let Some(bytes) = fsutil::read_range(path, start, size) else {
            return JsonlFile::empty();
        };
        let mut text = lossy(&bytes);
        if start > 0
            && let Some(nl) = text.find('\n')
        {
            text = text[nl + 1..].to_string();
        }
        (text, start > 0)
    } else {
        let Some(bytes) = fsutil::read_bytes(path) else {
            return JsonlFile::empty();
        };
        (lossy(&bytes), false)
    };
    let lines = parse_lines(&text);
    JsonlFile {
        objects: lines_objects(&lines),
        lines,
        truncated,
        text,
    }
}

pub fn kept_window_offset(bytes: &[u8], max_bytes: u64) -> (u64, bool) {
    let size = bytes.len() as u64;
    if size <= max_bytes {
        return (0, false);
    }
    let start = (size - max_bytes) as usize;
    let kept = bytes[start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| start + index + 1)
        .unwrap_or(start);
    (fsutil::lossy(&bytes[..kept]).len() as u64, true)
}

pub fn last_line_index(text: &str) -> usize {
    let mut count = 0usize;
    let mut rest = text;
    while let Some(idx) = rest.find('\n') {
        count = count.saturating_add(1);
        rest = &rest[idx + 1..];
    }
    count.saturating_sub(1)
}

pub(crate) fn stream_json_objects(
    path: &Path,
    size: u64,
    max_bytes: u64,
    mut on_object: impl FnMut(ParsedLine, bool),
) -> (usize, bool) {
    let truncated = size > max_bytes;
    let Ok(mut file) = std::fs::File::open(path) else {
        return (0, false);
    };
    let cut = size.saturating_sub(max_bytes);
    let mut window: Option<u64> = if truncated { None } else { Some(0) };
    let mut pending = Vec::new();
    let mut buf = [0_u8; 65_536];
    let mut remaining = size;
    let mut byte_off = 0u64;
    let mut lossy_off = 0u64;
    let mut index = 0usize;
    let mut scan_at = 0usize;
    while remaining > 0 {
        let want = usize::try_from(remaining.min(buf.len() as u64)).unwrap_or(0);
        if want == 0 {
            break;
        }
        let read = match file.read(&mut buf[..want]) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        remaining = remaining.saturating_sub(read as u64);
        pending.extend_from_slice(&buf[..read]);
        loop {
            let Some(rel) = pending[scan_at..].iter().position(|byte| *byte == b'\n') else {
                scan_at = pending.len();
                break;
            };
            let nl = scan_at + rel;
            let mut raw = pending.drain(..=nl).collect::<Vec<_>>();
            scan_at = 0;
            let raw_len = raw.len() as u64;
            let raw_decoded = decoded_len(&raw);
            let nl_at = byte_off.saturating_add(raw_len).saturating_sub(1);
            if truncated && window.is_none() && nl_at >= cut {
                window = Some(lossy_off.saturating_add(raw_decoded));
            }
            let start = lossy_off;
            let in_window = window.is_some_and(|bound| start >= bound);
            raw.pop();
            if raw.last() == Some(&b'\r') {
                raw.pop();
            }
            let text = String::from_utf8_lossy(&raw);
            let trimmed = jtrim(&text);
            if trimmed.starts_with('{')
                && let Ok(value) = crate::value::parse_json(trimmed)
                && value.is_object()
            {
                on_object(
                    ParsedLine {
                        index,
                        offset: start,
                        value,
                    },
                    in_window,
                );
            }
            byte_off = byte_off.saturating_add(raw_len);
            lossy_off = lossy_off.saturating_add(raw_decoded);
            index = index.saturating_add(1);
        }
    }
    (index, truncated)
}

fn decoded_len(bytes: &[u8]) -> u64 {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.len() as u64,
        Err(_) => String::from_utf8_lossy(bytes).len() as u64,
    }
}

pub fn parse_lines(text: &str) -> Vec<ParsedLine> {
    parse_lines_at(text, 0, 0)
}

pub fn parse_lines_at(text: &str, index_base: usize, offset_base: u64) -> Vec<ParsedLine> {
    let mut out = Vec::new();
    let mut offset = 0u64;
    for (index, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = jtrim(line);
        if trimmed.starts_with('{')
            && let Ok(value) = crate::value::parse_json(trimmed)
            && value.is_object()
        {
            out.push(ParsedLine {
                index: index_base.saturating_add(index),
                offset: offset_base.saturating_add(offset),
                value,
            });
        }
        offset = offset.saturating_add(raw.len() as u64).saturating_add(1);
    }
    out
}

pub fn lines_objects(lines: &[ParsedLine]) -> Vec<Obj> {
    lines
        .iter()
        .filter_map(|line| line.value.as_object().cloned())
        .collect()
}

pub fn objects_of(text: &str) -> Vec<Obj> {
    lines_objects(&parse_lines(text))
}

pub fn split_lines(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut rest = text;
    while let Some(idx) = rest.find('\n') {
        let mut line = &rest[..idx];
        if line.ends_with('\r') {
            line = &line[..line.len() - 1];
        }
        lines.push(line.to_string());
        rest = &rest[idx + 1..];
    }
    if !rest.is_empty() {
        let line = rest.strip_suffix('\r').unwrap_or(rest);
        lines.push(line.to_string());
    }
    lines
}

pub fn parse_object(text: &str) -> Option<Obj> {
    let value = crate::value::parse_json(text).ok()?;
    value.as_object().cloned()
}
