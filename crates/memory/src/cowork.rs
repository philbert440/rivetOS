use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoworkHookRow {
    pub id: String,
    pub role: String,
    pub content: String,
    pub event_id: String,
}

pub fn cowork_content_hash(role: &str, content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{role}\0{content}\0\0").as_bytes());
    hex::encode(hasher.finalize())
}

pub fn pick_cowork_hook_rewrite(
    role: &str,
    content: &str,
    source: Option<&str>,
    replaces_event_id: Option<&str>,
    rows: &[CoworkHookRow],
    consumed: &[String],
) -> Option<CoworkHookRow> {
    if source != Some("cowork-transcript") {
        return None;
    }
    if role != "user" && role != "assistant" {
        return None;
    }
    let open: Vec<&CoworkHookRow> = rows.iter().filter(|row| !consumed.iter().any(|id| id == &row.id)).collect();
    if let Some(replaces) = replaces_event_id.filter(|s| !s.is_empty())
        && let Some(direct) = open.iter().find(|row| row.event_id == replaces)
    {
        return Some((*direct).clone());
    }
    let want = cowork_content_hash(role, content);
    open.iter()
        .find(|row| row.role == role && cowork_content_hash(&row.role, &row.content) == want)
        .map(|row| (*row).clone())
}
