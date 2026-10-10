const STOP_WORDS: &[&str] = &[
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall", "to",
    "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "about", "like", "through",
    "after", "over", "between", "out", "against", "during", "without", "before", "under", "around",
    "among", "and", "but", "or", "nor", "not", "so", "yet", "both", "either", "neither", "each",
    "every", "all", "any", "few", "more", "most", "other", "some", "such", "no", "only", "own",
    "same", "than", "too", "very", "just", "because", "this", "that", "these", "those", "it",
    "its", "use", "when", "what", "how", "where", "which", "who", "whom", "why", "if", "then",
    "else", "also", "up", "down",
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub triggers: Option<Vec<String>>,
    pub version: Option<i64>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
}

pub fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let mut result = ParsedFrontmatter::default();
    if let Some(frontmatter) = frontmatter_block(content) {
        for line in frontmatter.split('\n') {
            let Some(colon) = line.find(':') else {
                continue;
            };
            let key = protocol::js::js_trim(&line[..colon]).to_lowercase();
            let value = protocol::js::js_trim(&line[colon + 1..]).to_string();
            match key.as_str() {
                "name" => result.name = Some(value),
                "description" => result.description = Some(value),
                "triggers" => {
                    result.triggers = Some(
                        value
                            .split(',')
                            .map(|item| protocol::js::js_trim(item).to_lowercase())
                            .filter(|item| !item.is_empty())
                            .collect(),
                    );
                }
                "version" => {
                    if let Some(parsed) = js_parse_int(&value) {
                        result.version = Some(parsed);
                    }
                }
                "category" => result.category = Some(value),
                "tags" => {
                    result.tags = Some(
                        value
                            .split(',')
                            .map(|item| protocol::js::js_trim(item).to_string())
                            .filter(|item| !item.is_empty())
                            .collect(),
                    );
                }
                _ => {}
            }
        }
        return result;
    }
    for line in content.split('\n') {
        let trimmed = protocol::js::js_trim(line);
        if result.name.is_none() && trimmed.starts_with('#') {
            result.name = Some(trim_heading(trimmed).to_string());
            continue;
        }
        if result.name.is_some()
            && result.description.is_none()
            && !trimmed.is_empty()
            && !trimmed.starts_with('#')
        {
            result.description = Some(trimmed.to_string());
            break;
        }
    }
    result
}

pub fn extract_triggers_from_description(description: &str) -> Vec<String> {
    let lowered = description.to_lowercase();
    let mut cleaned = String::new();
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || is_ws(ch) {
            cleaned.push(ch);
        } else {
            cleaned.push(' ');
        }
    }
    cleaned
        .split_whitespace()
        .filter(|word| word.len() > 2 && !STOP_WORDS.contains(word))
        .map(str::to_string)
        .collect()
}

fn frontmatter_block(content: &str) -> Option<&str> {
    if !content.starts_with("---") {
        return None;
    }
    let end = content[3..].find("---")? + 3;
    Some(protocol::js::js_trim(&content[3..end]))
}

fn trim_heading(trimmed: &str) -> &str {
    let rest = trimmed.trim_start_matches('#').trim_start();
    protocol::js::js_trim(rest)
}

fn is_ws(ch: char) -> bool {
    ch.is_whitespace()
}

fn js_parse_int(value: &str) -> Option<i64> {
    let trimmed = protocol::js::js_trim(value);
    let mut chars = trimmed.chars().peekable();
    let sign = match chars.peek() {
        Some('+') => {
            chars.next();
            1
        }
        Some('-') => {
            chars.next();
            -1
        }
        _ => 1,
    };
    let mut digits = String::new();
    for ch in chars {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().map(|number| number * sign)
}
