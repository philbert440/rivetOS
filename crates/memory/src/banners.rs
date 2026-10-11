use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use crate::get_full::format_browse_message_body;
use crate::report::time_since;
use crate::standard_helpers::js_to_fixed;
use crate::text::{utf16_len, utf16_prefix};
use crate::window::apply_window_args;

pub const SEARCH_CONTENT_LIMIT: usize = 400;
pub const SEARCH_TOOL_RESULT_LIMIT: usize = 500;
pub const SEARCH_SNIPPET_LIMIT: usize = 1500;
const EFFECT: &str = "Keyword / FTS ranking only — not meaning-based.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpDegraded {
    pub reason: String,
    pub effect: String,
}

pub fn format_vector_arm_unavailable(reason: &str, mode: Option<&str>, hit_count: i64) -> String {
    if mode == Some("trigram") || mode == Some("regex") {
        return String::new();
    }
    if mode == Some("vector") {
        let suffix = if hit_count > 0 {
            "showing fts fallback results"
        } else {
            "no results"
        };
        return format!("⚠ vector arm unavailable ({reason}) — {suffix}");
    }
    format!("⚠ vector arm unavailable ({reason}) — results are fts/trigram only")
}

pub fn format_chunk_arm_unavailable(reason: &str) -> String {
    format!("⚠ chunk arm unavailable ({reason}) — searching parent embeddings only")
}

pub fn http_search_degraded(reason: Option<&str>, embed_configured: bool) -> Option<HttpDegraded> {
    if let Some(reason) = reason {
        return Some(HttpDegraded {
            reason: reason.to_string(),
            effect: EFFECT.to_string(),
        });
    }
    if !embed_configured {
        return Some(HttpDegraded {
            reason: "embedding endpoint not configured".to_string(),
            effect: EFFECT.to_string(),
        });
    }
    None
}

pub fn tool_search_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(10).clamp(1, 50)
}

pub fn http_search_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(20).clamp(1, 50)
}

pub fn memory_search_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(20)
}

pub fn context_search_limit() -> i64 {
    10
}

pub fn format_empty_search_result(
    query: &str,
    since: Option<&str>,
    before: Option<&str>,
    window: Option<&str>,
) -> String {
    if since.is_some() || before.is_some() {
        let mut parts = Vec::new();
        if let Some(window) = window.filter(|value| !value.is_empty()) {
            parts.push(format!("window=\"{window}\""));
        } else if let Some(since) = since {
            parts.push(format!("since=\"{since}\""));
            if let Some(before) = before {
                parts.push(format!("before=\"{before}\""));
            }
        } else if let Some(before) = before {
            parts.push(format!("before=\"{before}\""));
        }
        let window_str = parts.join(", ");
        return format!(
            "No results found for query \"{query}\" with {window_str}.\n\nFor chronological browsing of a date window without a topic filter, call `memory_browse({window_str})` instead — that returns every message in the window, no FTS match required."
        );
    }
    format!(
        "No results found for query \"{query}\".\n\nIf you expected a hit: retry with `mode=\"trigram\"` for literal tokens (IPs, hostnames, error strings), or vary the angle (service / host / subnet / role) and try two more queries before trusting the empty result. For time-bounded questions (\"today\", \"yesterday\", \"last week\"), prefer `memory_browse` with window= — search ANDs the query with any date filter and returns empty when FTS misses."
    )
}

pub fn fmt_local_ts(dt: DateTime<Utc>) -> String {
    let local = dt.with_timezone(&chrono::Local);
    let tz = local.format("%Z").to_string();
    let base = local.format("%Y-%m-%d %H:%M:%S").to_string();
    if tz.is_empty() {
        base
    } else {
        format!("{base} {tz}")
    }
}

pub fn fmt_hit_when(dt: DateTime<Utc>, now_ms: i64) -> String {
    let then_ms = dt.timestamp_millis();
    format!("{} · {}", time_since(then_ms, now_ms), fmt_local_ts(dt))
}

#[derive(Debug, Clone)]
pub struct SnippetView {
    pub text: String,
    pub char_start: i64,
    pub char_end: i64,
    pub chunk_idx: i64,
    pub chunk_count: Option<i64>,
}

pub fn format_snippet_body(id: &str, snippet: &SnippetView, content_limit: usize) -> String {
    let position = match snippet.chunk_count {
        Some(count) if count > 0 => format!("{}/{}", snippet.chunk_idx + 1, count),
        _ => format!("{}", snippet.chunk_idx + 1),
    };
    let marker = format!(
        "…[chunk {position} · chars {}-{} → memory_get_full id={id}]…",
        snippet.char_start, snippet.char_end
    );
    let text = if utf16_len(&snippet.text) > content_limit {
        format!("{}…", utf16_prefix(&snippet.text, content_limit))
    } else {
        snippet.text.clone()
    };
    format!("{marker}\n{text}")
}

pub struct SearchBodyHit<'a> {
    pub id: &'a str,
    pub content: &'a str,
    pub tool_name: Option<&'a str>,
    pub tool_result: Option<&'a str>,
    pub truncated: bool,
    pub full_length: Option<f64>,
    pub snippet: Option<&'a SnippetView>,
}

pub fn format_search_message_body(hit: &SearchBodyHit<'_>) -> String {
    if let Some(snippet) = hit.snippet {
        return format_snippet_body(hit.id, snippet, SEARCH_SNIPPET_LIMIT);
    }
    let meta = if hit.truncated {
        let mut map = Map::new();
        map.insert("truncated".to_string(), Value::Bool(true));
        if let Some(len) = hit.full_length {
            map.insert("full_content_length".to_string(), serde_json::json!(len));
            map.insert(
                "full_tool_result_length".to_string(),
                serde_json::json!(len),
            );
        }
        Some(map)
    } else {
        None
    };
    format_browse_message_body(
        hit.id,
        hit.content,
        hit.tool_name,
        hit.tool_result,
        meta.as_ref(),
        SEARCH_CONTENT_LIMIT,
        SEARCH_TOOL_RESULT_LIMIT,
    )
}

#[derive(Debug, Clone)]
pub struct ToolHit {
    pub id: String,
    pub hit_type: String,
    pub content: String,
    pub role: String,
    pub agent: String,
    pub score: f64,
    pub created_at: DateTime<Utc>,
    pub kind: Option<String>,
    pub tool_name: Option<String>,
    pub tool_result: Option<String>,
    pub tags: Vec<String>,
    pub snippet: Option<SnippetView>,
    pub truncated: bool,
    pub full_length: Option<f64>,
    pub earliest_at: Option<DateTime<Utc>>,
    pub latest_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct ToolResults {
    pub hits: Vec<ToolHit>,
    pub degraded_reason: Option<String>,
    pub chunk_reason: Option<String>,
    pub mode: String,
}

pub fn format_search_tool_output(query: &str, results: &ToolResults, now_ms: i64) -> String {
    let mut banner = Vec::new();
    if let Some(reason) = &results.degraded_reason {
        let line =
            format_vector_arm_unavailable(reason, Some(&results.mode), results.hits.len() as i64);
        if !line.is_empty() {
            banner.push(line);
        }
    }
    if let Some(reason) = &results.chunk_reason {
        banner.push(format_chunk_arm_unavailable(reason));
    }
    let prefix = if banner.is_empty() {
        String::new()
    } else {
        format!("{}\n\n", banner.join("\n"))
    };
    if results.hits.is_empty() {
        return format!(
            "{prefix}{}",
            format_empty_search_result(query, None, None, None)
        );
    }
    let summaries: Vec<&ToolHit> = results
        .hits
        .iter()
        .filter(|h| h.hit_type == "summary")
        .collect();
    let messages: Vec<&ToolHit> = results
        .hits
        .iter()
        .filter(|h| h.hit_type != "summary")
        .collect();
    let mut sections = Vec::new();
    sections.push(format!("## Memory Search: \"{query}\""));
    sections.push(format!(
        "Found {} results ({} summaries, {} messages)\n",
        results.hits.len(),
        summaries.len(),
        messages.len()
    ));
    if !summaries.is_empty() {
        sections.push("### Summaries\n".to_string());
        for hit in summaries {
            let when = fmt_hit_when(hit.created_at, now_ms);
            let preview = clip(&hit.content, 300);
            let score = fixed(hit.score);
            let kind = hit.kind.as_deref().unwrap_or("summary");
            sections.push(format!(
                "- [{kind}/{}] ({when}, score: {score}){} {preview}",
                hit.id,
                tag_suffix(hit)
            ));
        }
        sections.push(String::new());
    }
    if !messages.is_empty() {
        sections.push("### Messages\n".to_string());
        for hit in messages {
            let when = fmt_hit_when(hit.created_at, now_ms);
            let tool = hit
                .tool_name
                .as_ref()
                .map(|name| format!(" [tool: {name}]"))
                .unwrap_or_default();
            let body = format_search_message_body(&SearchBodyHit {
                id: &hit.id,
                content: &hit.content,
                tool_name: hit.tool_name.as_deref(),
                tool_result: hit.tool_result.as_deref(),
                truncated: hit.truncated,
                full_length: hit.full_length,
                snippet: hit.snippet.as_ref(),
            });
            let score = fixed(hit.score);
            sections.push(format!(
                "- [{}/{}]{tool} ({when}, score: {score}){}\n{body}",
                hit.agent,
                hit.role,
                tag_suffix(hit)
            ));
        }
    }
    format!("{prefix}{}", sections.join("\n"))
}

fn tag_suffix(hit: &ToolHit) -> String {
    if hit.tags.is_empty() {
        String::new()
    } else {
        format!(" tags: {}", hit.tags.join(", "))
    }
}

fn clip(text: &str, limit: usize) -> String {
    if utf16_len(text) > limit {
        format!("{}…", utf16_prefix(text, limit))
    } else {
        text.to_string()
    }
}

fn fixed(score: f64) -> String {
    js_to_fixed(score, 3).unwrap_or_else(|_| format!("{score:.3}"))
}

pub fn search_failed_tag(tag: &str) -> String {
    format!("Search failed: tag must be key:value (got \"{tag}\")")
}

pub fn search_failed_window(
    window: Option<&str>,
    since: Option<&str>,
    before: Option<&str>,
    now: chrono::DateTime<chrono::Local>,
) -> Result<(Option<String>, Option<String>), String> {
    apply_window_args(window, since, before, now).map_err(|msg| format!("Search failed: {msg}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit() -> ToolHit {
        ToolHit {
            id: "m1".into(),
            hit_type: "message".into(),
            content: "we decided families.app is the package name".into(),
            role: "user".into(),
            agent: "grok".into(),
            score: 0.42,
            created_at: DateTime::parse_from_rfc3339("2026-08-12T18:00:00.000Z")
                .unwrap()
                .with_timezone(&Utc),
            kind: None,
            tool_name: None,
            tool_result: None,
            tags: Vec::new(),
            snippet: None,
            truncated: false,
            full_length: None,
            earliest_at: None,
            latest_at: None,
        }
    }

    fn results(hits: Vec<ToolHit>, reason: Option<&str>, mode: &str) -> ToolResults {
        ToolResults {
            hits,
            degraded_reason: reason.map(str::to_string),
            chunk_reason: None,
            mode: mode.into(),
        }
    }

    #[test]
    fn vector_and_chunk_banners_match() {
        assert_eq!(
            format_vector_arm_unavailable("timeout", None, 0),
            "⚠ vector arm unavailable (timeout) — results are fts/trigram only"
        );
        assert_eq!(
            format_vector_arm_unavailable("timeout", Some("hybrid"), 0),
            "⚠ vector arm unavailable (timeout) — results are fts/trigram only"
        );
        assert_eq!(
            format_vector_arm_unavailable("timeout", Some("vector"), 0),
            "⚠ vector arm unavailable (timeout) — no results"
        );
        assert_eq!(
            format_vector_arm_unavailable("timeout", Some("vector"), 3),
            "⚠ vector arm unavailable (timeout) — showing fts fallback results"
        );
        assert_eq!(
            format_vector_arm_unavailable("timeout", Some("trigram"), 1),
            ""
        );
        assert_eq!(
            format_vector_arm_unavailable("timeout", Some("regex"), 1),
            ""
        );
        assert_eq!(
            format_chunk_arm_unavailable("no SELECT on ros_message_chunks"),
            "⚠ chunk arm unavailable (no SELECT on ros_message_chunks) — searching parent embeddings only"
        );
    }

    #[test]
    fn http_degraded_effect_sentence() {
        let row = http_search_degraded(Some("timeout"), true).unwrap();
        assert_eq!(row.reason, "timeout");
        assert_eq!(row.effect, EFFECT);
        let row = http_search_degraded(None, false).unwrap();
        assert_eq!(row.reason, "embedding endpoint not configured");
        assert!(http_search_degraded(None, true).is_none());
    }

    #[test]
    fn caller_defaults() {
        assert_eq!(tool_search_limit(None), 10);
        assert_eq!(tool_search_limit(Some(0)), 1);
        assert_eq!(tool_search_limit(Some(80)), 50);
        assert_eq!(http_search_limit(None), 20);
        assert_eq!(http_search_limit(Some(0)), 1);
        assert_eq!(memory_search_limit(None), 20);
        assert_eq!(memory_search_limit(Some(0)), 0);
        assert_eq!(memory_search_limit(Some(80)), 80);
        assert_eq!(context_search_limit(), 10);
    }

    #[test]
    fn search_tool_banners_and_snippets() {
        let out = format_search_tool_output(
            "families.app",
            &results(vec![hit()], Some("timeout"), "hybrid"),
            0,
        );
        assert!(
            out.starts_with("⚠ vector arm unavailable (timeout) — results are fts/trigram only")
        );
        assert!(out.contains("## Memory Search:"));
        assert!(out.contains("families.app"));
        assert!(out.contains("0.420"));
        let empty =
            format_search_tool_output("nope", &results(vec![], Some("http 503"), "hybrid"), 0);
        assert!(
            empty.starts_with("⚠ vector arm unavailable (http 503) — results are fts/trigram only")
        );
        assert!(empty.contains("No results found"));
        let clean =
            format_search_tool_output("families.app", &results(vec![hit()], None, "hybrid"), 0);
        assert!(!clean.contains("vector arm unavailable"));
        let vector_empty =
            format_search_tool_output("nope", &results(vec![], Some("timeout"), "vector"), 0);
        assert!(vector_empty.starts_with("⚠ vector arm unavailable (timeout) — no results"));
        let vector_hits = format_search_tool_output(
            "families.app",
            &results(vec![hit()], Some("timeout"), "vector"),
            0,
        );
        assert!(
            vector_hits
                .starts_with("⚠ vector arm unavailable (timeout) — showing fts fallback results")
        );
        let mut snip = hit();
        snip.content =
            "filler prose about unrelated deploys that must not appear in the hit".into();
        snip.snippet = Some(SnippetView {
            text: "The V100 NVFP4 cudagraph cap must never be lower than seqs x (K+1).".into(),
            char_start: 6000,
            char_end: 7024,
            chunk_idx: 2,
            chunk_count: Some(7),
        });
        let out = format_search_tool_output(
            "nvfp4 cudagraph cap",
            &results(vec![snip], None, "hybrid"),
            0,
        );
        assert!(out.contains("[chunk 3/7"));
        assert!(out.contains("The V100 NVFP4 cudagraph cap"));
        assert!(out.contains("memory_get_full id=m1"));
        assert!(!out.contains("filler prose about unrelated deploys"));
        let mut chunked = results(vec![hit()], None, "hybrid");
        chunked.chunk_reason = Some("no SELECT on ros_message_chunks".into());
        let out = format_search_tool_output("families.app", &chunked, 0);
        assert!(out.starts_with("⚠ chunk arm unavailable (no SELECT on ros_message_chunks)"));
        assert!(out.contains("searching parent embeddings only"));
        assert!(out.contains("## Memory Search:"));
        let tri = format_search_tool_output(
            "families.app",
            &results(vec![hit()], Some("timeout"), "trigram"),
            0,
        );
        let reg = format_search_tool_output(
            "families.app",
            &results(vec![hit()], Some("timeout"), "regex"),
            0,
        );
        assert!(!tri.contains("vector arm unavailable"));
        assert!(!reg.contains("vector arm unavailable"));
        assert!(search_failed_tag("nocolon").starts_with("Search failed: tag must be key:value"));
    }

    #[test]
    fn empty_window_guidance() {
        let msg = format_empty_search_result("datahub IP", None, None, None);
        assert!(msg.contains("No results found for query \"datahub IP\""));
        assert!(msg.contains("mode=\"trigram\""));
        let msg =
            format_empty_search_result("q", Some("2026-01-01T00:00:00.000Z"), None, Some("today"));
        assert!(msg.contains("window=\"today\""));
        assert!(msg.contains("memory_browse"));
    }
}
