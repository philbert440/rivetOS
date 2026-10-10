use protocol::js::js_trim;

pub struct DeterminismFinding {
    pub line: i64,
    pub column: i64,
    pub rule: &'static str,
    pub message: &'static str,
    pub snippet: String,
}

struct Pattern {
    rule: &'static str,
    source: &'static str,
    message: &'static str,
}

const PATTERNS: &[Pattern] = &[
    Pattern {
        rule: "no-date-now",
        source: r"\bDate\.now\s*\(",
        message: "Date.now() is nondeterministic — use a step if you need wall clock",
    },
    Pattern {
        rule: "no-new-date",
        source: r"\bnew\s+Date\s*\(",
        message: "new Date() is nondeterministic in orchestration code",
    },
    Pattern {
        rule: "no-math-random",
        source: r"\bMath\.random\s*\(",
        message: "Math.random() is nondeterministic — use a step if you need entropy",
    },
    Pattern {
        rule: "no-fs-import",
        source: r#"\bfrom\s+['"]node:fs(?:\/promises)?['"]"#,
        message: "Direct fs import in run.ts — I/O must go through step.* calls",
    },
    Pattern {
        rule: "no-fs-require",
        source: r#"\brequire\s*\(\s*['"]fs['"]\s*\)"#,
        message: "Direct fs require in run.ts — I/O must go through step.* calls",
    },
    Pattern {
        rule: "no-fetch",
        source: r"\bfetch\s*\(",
        message: "fetch() in orchestration — network I/O must go through step.run/agent",
    },
];

pub fn check_run_script_determinism(source: &str) -> Vec<DeterminismFinding> {
    let lines = js_lines(source);
    let mut findings = Vec::new();
    for pattern in PATTERNS {
        let Ok(regex) = regress::Regex::new(pattern.source) else {
            continue;
        };
        let mut cursor = 0;
        while cursor <= source.len() {
            let Some(found) = regex.find(&source[cursor..]) else {
                break;
            };
            let offset = cursor + found.start();
            let (line, column) = offset_to_line_col(&lines, offset);
            let snippet = match lines.get((line as usize).saturating_sub(1)) {
                Some(text) => js_trim(text).to_string(),
                None => source[offset..cursor + found.end()].to_string(),
            };
            findings.push(DeterminismFinding {
                line,
                column,
                rule: pattern.rule,
                message: pattern.message,
                snippet,
            });
            let next = cursor + found.end();
            if next <= cursor {
                break;
            }
            cursor = next;
        }
    }
    findings
}

fn js_lines(source: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let bytes = source.as_bytes();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let end = if index > start && bytes[index - 1] == b'\r' {
                index - 1
            } else {
                index
            };
            lines.push(&source[start..end]);
            index += 1;
            start = index;
        } else {
            index += 1;
        }
    }
    lines.push(&source[start..]);
    lines
}

fn offset_to_line_col(lines: &[&str], offset: usize) -> (i64, i64) {
    let mut remaining = offset;
    for (index, line) in lines.iter().enumerate() {
        let len = line.len() + 1;
        if remaining < len {
            return (index as i64 + 1, remaining as i64 + 1);
        }
        remaining -= len;
    }
    (lines.len() as i64, 1)
}
