use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};

use crate::banners::fmt_hit_when;
use crate::embed_wire::vector_literal;
use crate::error::now_ms;
use crate::rows::{Bind, Cell, cell, text_cell};
use crate::search::{EngineOptions, SearchDb, SearchEngine, SearchFail};
use crate::text::{utf16_len, utf16_prefix};

const RECENT_SQL: &str = "SELECT m.content, m.role, m.created_at
       FROM ros_messages m
       JOIN ros_conversations c ON c.id = m.conversation_id
       WHERE c.agent = $1 AND c.active = true
         AND (c.session_key NOT LIKE 'heartbeat:%' OR c.session_key IS NULL)
       ORDER BY m.created_at DESC
       LIMIT 5";

const WIKI_PROBE_SQL: &str = "SELECT to_regclass('ros_wiki_topics') IS NOT NULL AS present";

const WIKI_FTS_SQL: &str = "SELECT slug, title, current_state, COALESCE(article, '') AS article,
            ts_rank(content_tsv, websearch_to_tsquery('english', $1))::float8 AS r
       FROM ros_wiki_topics
       WHERE content_tsv @@ websearch_to_tsquery('english', $1)
       ORDER BY r DESC LIMIT $2";

const WIKI_TRGM_SQL: &str = "SELECT slug, title, current_state, COALESCE(article, '') AS article,
            word_similarity($1, search_text)::float8 AS r
       FROM ros_wiki_topics
       WHERE $1 <% search_text
       ORDER BY r DESC LIMIT $2";

const WIKI_VEC_SQL: &str = "SELECT slug, title, current_state, COALESCE(article, '') AS article,
            (1 - (embedding <=> $1::halfvec))::float8 AS r
       FROM ros_wiki_topics
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::halfvec
       LIMIT $2";

const WIKI_RRF_K: f64 = 20.0;
const CONTEXT_SEARCH_LIMIT: i64 = 10;

#[derive(Debug, Clone, PartialEq)]
pub struct RecentLine {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WikiLine {
    pub title: String,
    pub slug: String,
    pub current_state: String,
    pub article: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RelevantLine {
    pub agent: String,
    pub role: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

struct Budget {
    tokens: i64,
    max_tokens: i64,
    seen: HashSet<String>,
    sections: Vec<String>,
}

pub async fn get_context_for_turn<D: SearchDb>(
    engine: &SearchEngine<D>,
    wiki_available: &AtomicBool,
    query: &str,
    agent: &str,
    max_tokens: i64,
) -> Result<String, SearchFail> {
    let recent = fetch_recent(engine, agent).await?;
    let wiki = if wiki_available.load(Ordering::Relaxed) {
        match fetch_wiki(engine, query).await {
            WikiFetch::Hits(hits) => hits,
            WikiFetch::Skip => Vec::new(),
            WikiFetch::LatchOff => {
                wiki_available.store(false, Ordering::Relaxed);
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let relevant = fetch_relevant(engine, query, agent).await?;
    Ok(assemble_context(
        &recent,
        &wiki,
        &relevant,
        max_tokens,
        now_ms(),
    ))
}

pub fn assemble_context(
    recent: &[RecentLine],
    wiki: &[WikiLine],
    relevant: &[RelevantLine],
    max_tokens: i64,
    now_ms: i64,
) -> String {
    let mut budget = Budget {
        tokens: 0,
        max_tokens,
        seen: HashSet::new(),
        sections: Vec::new(),
    };
    if !recent.is_empty() {
        budget.sections.push("\n## Recent".to_string());
        for row in recent.iter().rev() {
            if !push_seen_line(
                &mut budget,
                &dedup_key(&row.content),
                &format!("[{}] {}", row.role, utf16_prefix(&row.content, 500)),
                true,
            ) {
                break;
            }
        }
    }
    if !wiki.is_empty() {
        budget
            .sections
            .push("\n## Wiki (curated state)".to_string());
        for hit in wiki {
            let summary = utf16_prefix(&hit.current_state, 1200);
            let article = protocol::js::js_trim(&hit.article);
            let article_slice = if article.is_empty() {
                String::new()
            } else {
                format!("\n{}", utf16_prefix(article, 800))
            };
            let body = format!("{summary}{article_slice}");
            let line = format!("**{}** (wiki:{})\n{body}", hit.title, hit.slug);
            if !push_seen_line(&mut budget, &dedup_key(&summary), &line, false) {
                break;
            }
        }
    }
    if !relevant.is_empty() {
        budget.sections.push("\n## Relevant Context".to_string());
        for hit in relevant {
            let line = format!(
                "[{}/{}, {}] {}",
                hit.agent,
                hit.role,
                fmt_hit_when(hit.created_at, now_ms),
                utf16_prefix(&hit.content, 500)
            );
            if !push_seen_line(&mut budget, &dedup_key(&hit.content), &line, true) {
                break;
            }
        }
    }
    budget.sections.join("\n")
}

fn push_seen_line(budget: &mut Budget, dedup: &str, line: &str, skip_if_seen: bool) -> bool {
    if skip_if_seen && budget.seen.contains(dedup) {
        return true;
    }
    budget.seen.insert(dedup.to_string());
    budget.tokens += token_estimate(line);
    if budget.tokens > budget.max_tokens {
        return false;
    }
    budget.sections.push(line.to_string());
    true
}

fn dedup_key(text: &str) -> String {
    utf16_prefix(text, 300)
}

fn token_estimate(line: &str) -> i64 {
    let len = i64::try_from(utf16_len(line)).unwrap_or(i64::MAX);
    (len.saturating_add(3)) / 4
}

async fn fetch_recent<D: SearchDb>(
    engine: &SearchEngine<D>,
    agent: &str,
) -> Result<Vec<RecentLine>, SearchFail> {
    let rows = engine
        .database()
        .query(RECENT_SQL, &[Bind::Text(agent.to_string())])
        .await?;
    Ok(rows
        .rows
        .iter()
        .map(|row| RecentLine {
            role: text_cell(row, "role"),
            content: text_cell(row, "content"),
        })
        .collect())
}

enum WikiFetch {
    Hits(Vec<WikiLine>),
    Skip,
    LatchOff,
}

async fn fetch_wiki<D: SearchDb>(engine: &SearchEngine<D>, query: &str) -> WikiFetch {
    match engine.database().query(WIKI_PROBE_SQL, &[]).await {
        Ok(result) => {
            let present = result
                .rows
                .first()
                .and_then(|row| cell(row, "present"))
                .and_then(Cell::as_bool)
                == Some(true);
            if !present {
                return WikiFetch::LatchOff;
            }
        }
        Err(err) if wiki_missing(&err.message) => return WikiFetch::LatchOff,
        Err(_) => return WikiFetch::Skip,
    }
    let per_method = 3i64.saturating_mul(3).max(15);
    let fts = wiki_arm(
        engine,
        WIKI_FTS_SQL,
        &[Bind::Text(query.to_string()), Bind::I64(per_method)],
    )
    .await;
    let trgm = wiki_arm(
        engine,
        WIKI_TRGM_SQL,
        &[Bind::Text(query.to_string()), Bind::I64(per_method)],
    )
    .await;
    let vec = match engine.embed_wiki_text(query).await {
        Some(vec) => {
            wiki_arm(
                engine,
                WIKI_VEC_SQL,
                &[Bind::Text(vector_literal(&vec)), Bind::I64(per_method)],
            )
            .await
        }
        None => Vec::new(),
    };
    let fused = fuse_wiki([fts, trgm, vec]);
    WikiFetch::Hits(
        fused
            .into_iter()
            .take(3)
            .map(|hit| WikiLine {
                title: hit.title,
                slug: hit.slug,
                current_state: hit.current_state,
                article: hit.article,
            })
            .collect(),
    )
}

async fn wiki_arm<D: SearchDb>(
    engine: &SearchEngine<D>,
    sql: &str,
    params: &[Bind],
) -> Vec<WikiRow> {
    match engine.database().query(sql, params).await {
        Ok(result) => result.rows.iter().map(wiki_row).collect(),
        Err(_) => Vec::new(),
    }
}

struct WikiRow {
    slug: String,
    title: String,
    current_state: String,
    article: String,
}

fn wiki_row(row: &HashMap<String, Cell>) -> WikiRow {
    WikiRow {
        slug: text_cell(row, "slug"),
        title: text_cell(row, "title"),
        current_state: text_cell(row, "current_state"),
        article: text_cell(row, "article"),
    }
}

fn fuse_wiki(lists: [Vec<WikiRow>; 3]) -> Vec<WikiRow> {
    let mut scores: HashMap<String, f64> = HashMap::new();
    let mut rows: HashMap<String, WikiRow> = HashMap::new();
    let mut order = Vec::new();
    for list in lists {
        for (rank, row) in list.into_iter().enumerate() {
            let inc = 1.0 / (WIKI_RRF_K + rank as f64 + 1.0);
            if let Some(score) = scores.get_mut(&row.slug) {
                *score += inc;
            } else {
                order.push(row.slug.clone());
                scores.insert(row.slug.clone(), inc);
                rows.insert(row.slug.clone(), row);
            }
        }
    }
    let mut fused: Vec<(f64, WikiRow)> = order
        .into_iter()
        .filter_map(|slug| {
            let score = scores.remove(&slug)?;
            let row = rows.remove(&slug)?;
            Some((score, row))
        })
        .collect();
    fused.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    fused.into_iter().map(|(_, row)| row).collect()
}

fn wiki_missing(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("ros_wiki_topics") && lower.contains("does not exist")
}

async fn fetch_relevant<D: SearchDb>(
    engine: &SearchEngine<D>,
    query: &str,
    agent: &str,
) -> Result<Vec<RelevantLine>, SearchFail> {
    let options = EngineOptions {
        mode: Some("hybrid".to_string()),
        scope: Some("both".to_string()),
        limit: Some(CONTEXT_SEARCH_LIMIT),
        agent: Some(agent.to_string()),
        ..EngineOptions::default()
    };
    let results = engine.search(query, &options).await?;
    Ok(results
        .hits
        .into_iter()
        .map(|hit| RelevantLine {
            agent: hit.agent,
            role: hit.role,
            content: hit.content,
            created_at: hit.created_at,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 1, hour, 0, 0).unwrap()
    }

    #[test]
    fn budgets_headings_dedup_and_wiki_key() {
        let recent = vec![
            RecentLine {
                role: "user".to_string(),
                content: "newest".to_string(),
            },
            RecentLine {
                role: "assistant".to_string(),
                content: "older shared".to_string(),
            },
        ];
        let wiki = vec![WikiLine {
            title: "Families".to_string(),
            slug: "families".to_string(),
            current_state: "older shared".to_string(),
            article: "  article body  ".to_string(),
        }];
        let relevant = vec![
            RelevantLine {
                agent: "grok".to_string(),
                role: "user".to_string(),
                content: "older shared".to_string(),
                created_at: at(12),
            },
            RelevantLine {
                agent: "grok".to_string(),
                role: "assistant".to_string(),
                content: "fresh hit".to_string(),
                created_at: at(12),
            },
        ];
        let text = assemble_context(&recent, &wiki, &relevant, 4000, at(12).timestamp_millis());
        assert!(text.starts_with("\n## Recent\n[assistant] older shared\n[user] newest"));
        assert!(text.contains(
            "\n## Wiki (curated state)\n**Families** (wiki:families)\nolder shared\narticle body"
        ));
        assert!(text.contains("\n## Relevant Context\n"));
        assert!(text.contains("fresh hit"));
        assert!(text.contains("just now"));
        assert!(!text.contains("[grok/user"));
        let dropped = assemble_context(&recent, &[], &[], 1, 0);
        assert_eq!(dropped, "\n## Recent");
        assert_eq!(assemble_context(&[], &[], &[], 4000, 0), "");
        let wiki_only = assemble_context(
            &[],
            &[WikiLine {
                title: "T".to_string(),
                slug: "t".to_string(),
                current_state: "state".to_string(),
                article: String::new(),
            }],
            &[],
            1,
            0,
        );
        assert_eq!(wiki_only, "\n## Wiki (curated state)");
    }

    #[test]
    fn wiki_ties_keep_insertion_order() {
        let row = |slug: &str| WikiRow {
            slug: slug.to_string(),
            title: slug.to_string(),
            current_state: String::new(),
            article: String::new(),
        };
        let fused = fuse_wiki([
            vec![row("zeta"), row("yankee")],
            vec![row("alpha"), row("bravo")],
            vec![],
        ]);
        let slugs: Vec<&str> = fused.iter().map(|item| item.slug.as_str()).collect();
        assert_eq!(slugs, ["zeta", "alpha", "yankee", "bravo"]);
    }
}
