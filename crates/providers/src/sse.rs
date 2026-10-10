pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Vec<(String, String)> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            let Some((at, len)) = find_sep(&self.buf) else {
                break;
            };
            let block: Vec<u8> = self.buf.drain(..at + len).take(at).collect();
            if block.iter().all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n')) {
                continue;
            }
            out.push(parse_block(&block));
        }
        out
    }

    pub fn finish(&mut self) -> Vec<(String, String)> {
        if self
            .buf
            .iter()
            .all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.buf.clear();
            return Vec::new();
        }
        let block = std::mem::take(&mut self.buf);
        vec![parse_block(&block)]
    }
}

impl Default for SseParser {
    fn default() -> Self {
        Self::new()
    }
}

fn find_sep(buf: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0;
    while index + 1 < buf.len() {
        if index + 3 < buf.len() && buf[index..index + 4] == *b"\r\n\r\n" {
            return Some((index, 4));
        }
        if buf[index] == b'\n' && buf[index + 1] == b'\n' {
            return Some((index, 2));
        }
        index += 1;
    }
    None
}

fn parse_block(block: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(block);
    let mut event = String::new();
    let mut data = Vec::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("event:") {
            event = rest.trim_start().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data.push(rest.trim_start().to_string());
        }
    }
    (event, data.join("\n"))
}

pub struct NdjsonParser {
    buf: Vec<u8>,
}

impl NdjsonParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let mut line = String::from_utf8_lossy(&line).into_owned();
            if line.ends_with('\n') {
                line.pop();
            }
            if line.ends_with('\r') {
                line.pop();
            }
            if !line.is_empty() {
                out.push(line);
            }
        }
        out
    }

    pub fn finish(&mut self) -> Vec<String> {
        if self.buf.is_empty() {
            return Vec::new();
        }
        let mut line = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        if line.ends_with('\n') {
            line.pop();
        }
        if line.ends_with('\r') {
            line.pop();
        }
        if line.is_empty() {
            Vec::new()
        } else {
            vec![line]
        }
    }
}

impl Default for NdjsonParser {
    fn default() -> Self {
        Self::new()
    }
}
