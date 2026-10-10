use std::path::Path;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::security::scan_skill_content;

pub const ALLOWED_SUBDIRS: &[&str] = &["references", "scripts", "assets", "templates"];
pub const DEDUP_THRESHOLD: f64 = 0.85;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkillMeta {
    pub created_by: String,
    pub created_at: String,
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_reason: Option<String>,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    if left.is_empty() || right.is_empty() || left.len() != right.len() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_left = 0.0;
    let mut norm_right = 0.0;
    for (a, b) in left.iter().zip(right) {
        dot += a * b;
        norm_left += a * a;
        norm_right += b * b;
    }
    let denom = norm_left.sqrt() * norm_right.sqrt();
    if denom == 0.0 { 0.0 } else { dot / denom }
}

pub async fn atomic_write(path: &Path, content: &str) -> Result<(), std::io::Error> {
    let tmp = format!("{}.tmp", path.display());
    tokio::fs::write(&tmp, content).await?;
    tokio::fs::rename(&tmp, path).await
}

pub async fn read_meta(skill_dir: &Path) -> Option<SkillMeta> {
    let raw = tokio::fs::read_to_string(skill_dir.join("_meta.json"))
        .await
        .ok()?;
    serde_json::from_str(&raw).ok()
}

pub async fn write_meta(skill_dir: &Path, meta: &SkillMeta) -> Result<(), std::io::Error> {
    let body = serde_json::to_string_pretty(meta).unwrap_or_else(|_| "{}".to_string());
    atomic_write(&skill_dir.join("_meta.json"), &format!("{body}\n")).await
}

pub async fn list_subdir(skill_dir: &Path, subdir: &str) -> Vec<String> {
    let dir = skill_dir.join(subdir);
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut files = Vec::new();
    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => {
                if entry
                    .file_type()
                    .await
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
                {
                    files.push(format!("{subdir}/{}", entry.file_name().to_string_lossy()));
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
    files
}

pub fn parse_patch_blocks(content: &str) -> Vec<(String, String)> {
    let Ok(finder) = regress::Regex::with_flags("^FIND:", "m") else {
        return Vec::new();
    };
    let Ok(find_re) = regress::Regex::with_flags(r"^FIND:\s*([\s\S]*?)(?=\nREPLACE:)", "m") else {
        return Vec::new();
    };
    let Ok(replace_re) = regress::Regex::with_flags(r"\nREPLACE:\s*([\s\S]*?)$", "m") else {
        return Vec::new();
    };
    let mut starts: Vec<usize> = finder.find_iter(content).map(|item| item.start()).collect();
    if starts.is_empty() {
        return Vec::new();
    }
    if starts[0] != 0 {
        starts.insert(0, 0);
    }
    let mut blocks = Vec::new();
    for (index, start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(content.len());
        let Some(part) = content.get(*start..end) else {
            continue;
        };
        if protocol::js::js_trim(part).is_empty() {
            continue;
        }
        let Some(find_caps) = find_re.find(part) else {
            continue;
        };
        let Some(replace_caps) = replace_re.find(part) else {
            continue;
        };
        let Some(find) = regress_group(part, &find_caps, 1) else {
            continue;
        };
        let Some(replace) = regress_group(part, &replace_caps, 1) else {
            continue;
        };
        blocks.push((trim_end(find), trim_end(replace)));
    }
    blocks
}

fn regress_group<'a>(text: &'a str, matched: &regress::Match, index: usize) -> Option<&'a str> {
    text.get(matched.group(index)?)
}

pub fn bump_version_in_content(content: &str, new_version: i64, reason: Option<&str>) -> String {
    let mut updated = content.to_string();
    if let Some(end_rel) = content
        .starts_with("---")
        .then(|| content[3..].find("---"))
        .flatten()
    {
        let end_idx = end_rel + 3;
        let frontmatter = &content[3..end_idx];
        let after = &content[end_idx..];
        if let Ok(version_re) = Regex::new(r"(?m)^version:\s*\d+") {
            if version_re.is_match(frontmatter) {
                let new_fm = version_re
                    .replace(frontmatter, format!("version: {new_version}"))
                    .into_owned();
                updated = format!("---{new_fm}{after}");
            } else {
                updated = format!("---{frontmatter}version: {new_version}\n{after}");
            }
        }
    }
    let entry = changelog_entry(new_version, reason);
    if let Some(index) = updated.find("## Changelog\n") {
        let mut next = String::new();
        next.push_str(&updated[..index]);
        next.push_str("## Changelog\n");
        next.push_str(&entry);
        next.push('\n');
        next.push_str(&updated[index + "## Changelog\n".len()..]);
        updated = next;
    } else {
        updated = format!("{}\n\n## Changelog\n{entry}\n", updated.trim_end());
    }
    updated
}

pub fn changelog_entry(version: i64, reason: Option<&str>) -> String {
    let date = now_iso().chars().take(10).collect::<String>();
    let message = reason.unwrap_or("Updated");
    format!("- **v{version}** ({date}): {message}")
}

pub fn scan_issues(content: &str) -> Result<(), String> {
    let scan = scan_skill_content(content);
    if scan.safe {
        Ok(())
    } else {
        Err(scan
            .issues
            .iter()
            .map(|issue| format!("  - {issue}"))
            .collect::<Vec<_>>()
            .join("\n"))
    }
}

pub fn title_case_hyphen(name: &str) -> String {
    name.split('-')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => {
                    let mut titled = first.to_uppercase().collect::<String>();
                    titled.extend(chars);
                    titled
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn under_roots(path: &Path, roots: &[String]) -> bool {
    let path = normalize(path);
    roots
        .iter()
        .any(|root| path.starts_with(normalize(Path::new(root))))
}

pub fn normalize(path: &Path) -> std::path::PathBuf {
    let mut out = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        std::path::PathBuf::from(".")
    } else {
        out
    }
}

fn trim_end(value: &str) -> String {
    value.trim_end().to_string()
}

pub async fn embed_text(
    http: &dyn tools::HttpClient,
    endpoint: &str,
    text: &str,
    model: &str,
) -> Option<Vec<f64>> {
    if model.is_empty() {
        return None;
    }
    let input = utf16_prefix(text, 8000);
    let body = serde_json::json!({ "input": input, "model": model }).to_string();
    let response = http
        .send(tools::HttpRequest {
            method: "POST".to_string(),
            url: format!("{endpoint}/v1/embeddings"),
            headers: vec![("Content-Type".to_string(), "application/json".to_string())],
            body: Some(body),
            timeout: std::time::Duration::from_secs(10),
        })
        .await
        .ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    let data: serde_json::Value = serde_json::from_str(&response.body).ok()?;
    let mut vec = data
        .get("data")?
        .as_array()?
        .first()?
        .get("embedding")?
        .as_array()?
        .iter()
        .filter_map(|value| value.as_f64())
        .collect::<Vec<_>>();
    vec.truncate(4000);
    Some(vec)
}

pub async fn check_dedup(
    http: &dyn tools::HttpClient,
    endpoint: &str,
    description: &str,
    existing: &[(String, String)],
    model: &str,
) -> Option<(String, f64)> {
    if model.is_empty() {
        return None;
    }
    let new_vec = embed_text(http, endpoint, description, model).await?;
    let mut best: Option<(String, f64)> = None;
    for (name, existing_description) in existing {
        let Some(existing_vec) = embed_text(http, endpoint, existing_description, model).await
        else {
            continue;
        };
        let similarity = cosine_similarity(&new_vec, &existing_vec);
        if similarity > DEDUP_THRESHOLD
            && best.as_ref().is_none_or(|(_, score)| similarity > *score)
        {
            best = Some((name.clone(), similarity));
        }
    }
    best
}

fn utf16_prefix(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}
