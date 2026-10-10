pub fn encode_uri_component(text: &str) -> String {
    const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
    let mut out = String::new();
    for byte in text.as_bytes() {
        if UNRESERVED.contains(byte) {
            out.push(*byte as char);
        } else {
            const HEX: &[u8] = b"0123456789ABCDEF";
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xf) as usize] as char);
        }
    }
    out
}

pub fn encode_pi_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    let base = if trimmed.is_empty() { "/" } else { trimmed };
    let slashed = if base == "/" { "/".to_string() } else { format!("{base}/") };
    format!("-{}-", slashed.replace('/', "-"))
}

pub fn encode_qwen_cwd(cwd: &str) -> String {
    cwd.replace('/', "-")
}

pub fn cursor_project_slug(cwd: &str, base: &std::path::Path) -> String {
    let resolved = crate::fsutil::node_resolve(base, cwd);
    let text = resolved.to_string_lossy();
    let stripped = text.trim_start_matches(['/', '\\']);
    stripped.replace(['/', '\\'], "-")
}
