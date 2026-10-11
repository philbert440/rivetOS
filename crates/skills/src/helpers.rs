use std::path::Path;

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

pub fn current_iso_timestamp() -> String {
    protocol::js::to_iso_string(protocol::js::date_now()).unwrap_or_default()
}

pub fn current_utc_day() -> String {
    protocol::js::utc_day(protocol::js::date_now()).unwrap_or_default()
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

pub async fn read_meta(skill_dir: &Path) -> Option<SkillMeta> {
    let raw = tokio::fs::read_to_string(skill_dir.join("_meta.json"))
        .await
        .ok()?;
    serde_json::from_str(&raw).ok()
}

pub async fn write_meta(
    skill_dir: &Path,
    meta: &SkillMeta,
    roots: &[String],
) -> Result<(), String> {
    let body = serde_json::to_string_pretty(meta).unwrap_or_else(|_| "{}".to_string());
    crate::confine::write_confined(&skill_dir.join("_meta.json"), &format!("{body}\n"), roots).await
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
        blocks.push((
            protocol::js::js_trim_end(find).to_string(),
            protocol::js::js_trim_end(replace).to_string(),
        ));
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
        if let Ok(version_re) = regress::Regex::with_flags(r"^version:\s*\d+", "m") {
            updated = if let Some(found) = version_re.find(frontmatter) {
                let new_fm = format!(
                    "{}version: {new_version}{}",
                    &frontmatter[..found.start()],
                    &frontmatter[found.end()..]
                );
                format!("---{new_fm}{after}")
            } else {
                format!("---{frontmatter}version: {new_version}\n{after}")
            };
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
        updated = format!(
            "{}\n\n## Changelog\n{entry}\n",
            protocol::js::js_trim_end(&updated)
        );
    }
    updated
}

pub fn changelog_entry(version: i64, reason: Option<&str>) -> String {
    let date = current_utc_day();
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

pub async fn read_node_text(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    match tokio::task::spawn_blocking(move || protocol::host::read_text(&path)).await {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(err)) => Err(err.to_string()),
        Err(err) => Err(err.to_string()),
    }
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
    let input = protocol::js::js_substring(text, Some(0.0), Some(8000.0))
        .to_utf8()
        .to_string();
    let body = serde_json::json!({ "input": input, "model": model }).to_string();
    let mut response = http
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
    let body = response.text().await.ok()?;
    let data: serde_json::Value = serde_json::from_str(&body).ok()?;
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
