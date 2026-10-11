#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanResult {
    pub safe: bool,
    pub issues: Vec<String>,
}

pub fn scan_skill_content(content: &str) -> ScanResult {
    let mut issues = Vec::new();
    if content.contains("$(") {
        issues.push("Shell injection: $(...) command substitution".to_string());
    }
    if matches(
        r"(?<!`)`(?!``)[^`]*\b(?:rm|curl|wget|cat|echo|sh|bash)\b[^`]*`(?!`)",
        "",
        content,
    ) {
        issues.push("Possible shell injection via backtick execution".to_string());
    }
    if matches(r"\beval\s*\(", "", content) {
        issues.push("Unsafe eval() call".to_string());
    }
    if matches(r"\bexec\s*\(", "", content) {
        issues.push("Unsafe exec() call".to_string());
    }
    if matches(r"\bsystem\s*\(", "", content) {
        issues.push("Unsafe system() call".to_string());
    }
    if matches(r"\bchild_process\b", "", content) {
        issues.push("Direct child_process usage".to_string());
    }
    if matches(r#"password\s*[=:]\s*["'][^"']+["']"#, "i", content) {
        issues.push("Hardcoded password detected".to_string());
    }
    if matches(r#"api[_-]?key\s*[=:]\s*["'][^"']+["']"#, "i", content) {
        issues.push("Hardcoded API key detected".to_string());
    }
    if matches(r#"\bsecret\s*[=:]\s*["'][^"']+["']"#, "i", content) {
        issues.push("Hardcoded secret detected".to_string());
    }
    if matches(r"\bAWS_SECRET", "i", content) {
        issues.push("AWS secret reference detected".to_string());
    }
    if matches(r"rm\s+-rf\s+/(?!\w)", "i", content) {
        issues.push("Dangerous rm -rf / command".to_string());
    }
    if matches(r"chmod\s+777", "", content) {
        issues.push("Insecure chmod 777".to_string());
    }
    if matches(r">\s*/etc/", "", content) {
        issues.push("Writing to /etc/".to_string());
    }
    if matches(r"curl\b.*(?:--data|-d\s)", "", content)
        && matches(
            r"curl\b.*https?://(?!localhost|127\.|10\.|192\.168\.)",
            "",
            content,
        )
    {
        issues.push("Possible data exfiltration via curl".to_string());
    }
    ScanResult {
        safe: issues.is_empty(),
        issues,
    }
}

fn matches(pattern: &str, flags: &str, text: &str) -> bool {
    let compiled = if flags.is_empty() {
        regress::Regex::new(pattern)
    } else {
        regress::Regex::with_flags(pattern, flags)
    };
    compiled
        .ok()
        .and_then(|regex| regex.find(text).map(|_| ()))
        .is_some()
}
