pub fn normalize_slug(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let mut out = String::new();
    let mut pending_dash = false;
    let mut started = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && started {
                out.push('-');
            }
            pending_dash = false;
            started = true;
            out.push(ch);
        } else {
            pending_dash = true;
        }
    }
    if out.len() > 80 {
        out.truncate(80);
    }
    out
}

pub fn extract_wiki_links(markdown: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut index = 0usize;
    while index < markdown.len() {
        if markdown[index..].starts_with("[[") {
            let start = index + 2;
            let mut end = start;
            while end < markdown.len() {
                let Some(ch) = markdown[end..].chars().next() else {
                    break;
                };
                if ch.is_ascii_alphanumeric() || ch == '-' {
                    end += ch.len_utf8();
                } else {
                    break;
                }
            }
            if end > start && markdown[end..].starts_with("]]") {
                let slug = normalize_slug(&markdown[start..end]);
                if !slug.is_empty() && seen.insert(slug.clone()) {
                    out.push(slug);
                }
                index = end + 2;
                continue;
            }
        }
        let Some(ch) = markdown[index..].chars().next() else {
            break;
        };
        index += ch.len_utf8();
    }
    out
}

pub fn is_read_slug(slug: &str) -> bool {
    let len = slug.chars().count();
    (1..=80).contains(&len)
        && slug
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

pub fn read_slug_error(slug: &str) -> Option<String> {
    if is_read_slug(slug) {
        None
    } else {
        Some(format!(
            "Invalid slug \"{slug}\" — lowercase kebab-case only."
        ))
    }
}
