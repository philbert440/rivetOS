use std::collections::HashMap;

use chrono::{DateTime, Utc};

use crate::banners::{
    SnippetView, ToolChild, ToolExpansion, ToolHit, ToolResults, ToolSource,
    format_search_tool_output,
};
use crate::rows::{Bind, Cell, DbFail, cell, text_cell};
use crate::search::{SearchDb, SearchHit};
use crate::text::utf16_len;

const DESCRIBE_SQL: &str = "SELECT id, conversation_id, kind, depth, content, message_count,
              earliest_at, latest_at, created_at, model, access_count
       FROM ros_summaries
       WHERE id = $1::uuid";

const CHILDREN_SQL: &str = "SELECT id, conversation_id, kind, depth, content, message_count,
              earliest_at, latest_at, created_at, model, access_count
       FROM ros_summaries
       WHERE parent_id = $1::uuid
       ORDER BY created_at";

const SOURCES_SQL: &str = "SELECT m.id, m.role, m.content, m.created_at
       FROM ros_messages m
       JOIN ros_summary_sources ss ON ss.message_id = m.id
       WHERE ss.summary_id = $1::uuid
       ORDER BY ss.ordinal";

#[derive(Debug, Clone, PartialEq)]
pub struct SummaryNode {
    pub summary_id: String,
    pub conversation_id: Option<String>,
    pub kind: String,
    pub depth: i64,
    pub content: String,
    pub message_count: i64,
    pub earliest_at: Option<DateTime<Utc>>,
    pub latest_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub model: Option<String>,
    pub access_count: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SourceMessage {
    pub message_id: String,
    pub role: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExpandResult {
    pub summary: SummaryNode,
    pub children: Vec<SummaryNode>,
    pub source_messages: Vec<SourceMessage>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExpandedSummary {
    pub hit_id: String,
    pub depth: i64,
    pub children: Vec<SummaryNode>,
    pub source_messages: Vec<SourceMessage>,
}

pub struct Expander<D: SearchDb> {
    db: D,
}

impl<D: SearchDb> Expander<D> {
    pub fn new(db: D) -> Self {
        Self { db }
    }

    pub async fn describe(&self, summary_id: &str) -> Result<Option<SummaryNode>, DbFail> {
        let rows = self
            .db
            .query(DESCRIBE_SQL, &[Bind::Text(summary_id.to_string())])
            .await?;
        Ok(rows.rows.first().map(node_from_row))
    }

    pub async fn expand(&self, summary_id: &str) -> Result<Option<ExpandResult>, DbFail> {
        let Some(summary) = self.describe(summary_id).await? else {
            return Ok(None);
        };
        let (children, source_messages) =
            tokio::join!(self.children(summary_id), self.sources(summary_id),);
        Ok(Some(ExpandResult {
            summary,
            children: children?,
            source_messages: source_messages?,
        }))
    }

    pub async fn expand_deep(
        &self,
        summary_id: &str,
        max_depth: i64,
    ) -> Result<Option<ExpandResult>, DbFail> {
        let Some(mut result) = self.expand(summary_id).await? else {
            return Ok(None);
        };
        if max_depth <= 1 {
            return Ok(Some(result));
        }
        for child in result.children.clone() {
            if let Some(nested) =
                Box::pin(self.expand_deep(&child.summary_id, max_depth - 1)).await?
            {
                result.source_messages.extend(nested.source_messages);
            }
        }
        Ok(Some(result))
    }

    async fn children(&self, summary_id: &str) -> Result<Vec<SummaryNode>, DbFail> {
        let rows = self
            .db
            .query(CHILDREN_SQL, &[Bind::Text(summary_id.to_string())])
            .await?;
        Ok(rows.rows.iter().map(node_from_row).collect())
    }

    async fn sources(&self, summary_id: &str) -> Result<Vec<SourceMessage>, DbFail> {
        let rows = self
            .db
            .query(SOURCES_SQL, &[Bind::Text(summary_id.to_string())])
            .await?;
        Ok(rows.rows.iter().map(source_from_row).collect())
    }
}

pub struct SearchToolView {
    pub since: Option<String>,
    pub before: Option<String>,
    pub window: Option<String>,
    pub expand: bool,
    pub mode: String,
    pub degraded_reason: Option<String>,
    pub chunk_reason: Option<String>,
    pub now_ms: i64,
}

impl Default for SearchToolView {
    fn default() -> Self {
        Self {
            since: None,
            before: None,
            window: None,
            expand: true,
            mode: "hybrid".to_string(),
            degraded_reason: None,
            chunk_reason: None,
            now_ms: 0,
        }
    }
}

pub async fn search_tool_output<D: SearchDb>(
    expander: &Expander<D>,
    query: &str,
    hits: &[SearchHit],
    view: &SearchToolView,
) -> String {
    let expanded = if view.expand {
        auto_expand_summaries(expander, hits)
            .await
            .into_iter()
            .map(|item| ToolExpansion {
                hit_id: item.hit_id,
                children: item
                    .children
                    .into_iter()
                    .map(|child| ToolChild {
                        kind: child.kind,
                        content: child.content,
                    })
                    .collect(),
                source_messages: item
                    .source_messages
                    .into_iter()
                    .map(|message| ToolSource {
                        role: message.role,
                        content: message.content,
                    })
                    .collect(),
            })
            .collect()
    } else {
        Vec::new()
    };
    format_search_tool_output(
        query,
        &ToolResults {
            hits: hits.iter().map(tool_hit_from_search).collect(),
            degraded_reason: view.degraded_reason.clone(),
            chunk_reason: view.chunk_reason.clone(),
            mode: view.mode.clone(),
            since: view.since.clone(),
            before: view.before.clone(),
            window: view.window.clone(),
            expand: view.expand,
            expanded,
        },
        view.now_ms,
    )
}

fn tool_hit_from_search(hit: &SearchHit) -> ToolHit {
    ToolHit {
        id: hit.id.clone(),
        hit_type: hit.hit_type.clone(),
        content: hit.content.clone(),
        role: hit.role.clone(),
        agent: hit.agent.clone(),
        score: hit.score,
        created_at: hit.created_at,
        kind: hit.kind.clone(),
        tool_name: hit.tool_name.clone(),
        tool_result: hit.tool_result.clone(),
        tags: Vec::new(),
        snippet: hit.snippet.as_ref().map(|snippet| SnippetView {
            text: snippet.text.clone(),
            char_start: snippet.char_start,
            char_end: snippet.char_end,
            chunk_idx: snippet.chunk_idx,
            chunk_count: snippet.chunk_count,
        }),
        truncated: hit.truncated,
        full_length: hit.full_length.map(|len| len as f64),
        earliest_at: hit.earliest_at,
        latest_at: hit.latest_at,
    }
}

pub fn expand_depth(score: f64) -> i64 {
    if score > 0.5 { 3 } else { 2 }
}

pub fn substantive_source_messages(messages: &[SourceMessage]) -> Vec<SourceMessage> {
    messages
        .iter()
        .filter(|message| {
            message.role != "tool" && utf16_len(protocol::js::js_trim(&message.content)) >= 40
        })
        .cloned()
        .collect()
}

pub async fn auto_expand_summaries<D: SearchDb>(
    expander: &Expander<D>,
    hits: &[SearchHit],
) -> Vec<ExpandedSummary> {
    let mut out = Vec::new();
    for hit in hits.iter().filter(|hit| hit.hit_type == "summary").take(3) {
        let depth = expand_depth(hit.score);
        match expander.expand_deep(&hit.id, depth).await {
            Ok(None) => continue,
            Ok(Some(expanded)) => out.push(ExpandedSummary {
                hit_id: hit.id.clone(),
                depth,
                children: expanded.children,
                source_messages: expanded.source_messages,
            }),
            Err(_) => out.push(ExpandedSummary {
                hit_id: hit.id.clone(),
                depth,
                children: Vec::new(),
                source_messages: Vec::new(),
            }),
        }
    }
    out
}

fn node_from_row(row: &HashMap<String, Cell>) -> SummaryNode {
    SummaryNode {
        summary_id: text_cell(row, "id"),
        conversation_id: opt_text(row, "conversation_id"),
        kind: text_cell(row, "kind"),
        depth: loose_i64(row, "depth").unwrap_or(0),
        content: text_cell(row, "content"),
        message_count: loose_i64(row, "message_count").unwrap_or(0),
        earliest_at: row_time(row, "earliest_at"),
        latest_at: row_time(row, "latest_at"),
        created_at: row_time(row, "created_at").unwrap_or(DateTime::<Utc>::UNIX_EPOCH),
        model: opt_text(row, "model"),
        access_count: loose_i64(row, "access_count").unwrap_or(0),
    }
}

fn source_from_row(row: &HashMap<String, Cell>) -> SourceMessage {
    SourceMessage {
        message_id: text_cell(row, "id"),
        role: text_cell(row, "role"),
        content: text_cell(row, "content"),
        created_at: row_time(row, "created_at").unwrap_or(DateTime::<Utc>::UNIX_EPOCH),
    }
}

fn opt_text(row: &HashMap<String, Cell>, name: &str) -> Option<String> {
    match cell(row, name) {
        Some(Cell::Null) | None => None,
        Some(Cell::Text(text)) if text.is_empty() => None,
        Some(other) => other.as_text().map(str::to_string),
    }
}

fn loose_i64(row: &HashMap<String, Cell>, name: &str) -> Option<i64> {
    let cell = cell(row, name)?;
    cell.as_i64()
        .or_else(|| cell.as_f64().map(|value| value as i64))
}

fn row_time(row: &HashMap<String, Cell>, name: &str) -> Option<DateTime<Utc>> {
    let text = cell(row, name).and_then(Cell::as_text)?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use chrono::TimeZone;
    use parking_lot::Mutex;

    use crate::rows::QueryResult;
    use crate::search::{SearchSession, SearchSnippet};

    #[derive(Clone)]
    struct MemDb {
        nodes: Arc<Mutex<HashMap<String, SummaryNode>>>,
        children: Arc<Mutex<HashMap<String, Vec<String>>>>,
        sources: Arc<Mutex<HashMap<String, Vec<SourceMessage>>>>,
        fail: Arc<Mutex<bool>>,
    }

    struct Idle;

    impl SearchSession for Idle {
        async fn query(&mut self, _sql: &str, _params: &[Bind]) -> Result<QueryResult, DbFail> {
            Err(DbFail::new("no session"))
        }

        fn release(&mut self, _err: Option<DbFail>) {}
    }

    impl SearchDb for MemDb {
        type Session = Idle;

        async fn query(&self, sql: &str, params: &[Bind]) -> Result<QueryResult, DbFail> {
            if *self.fail.lock() {
                return Err(DbFail::new("expand failed"));
            }
            let id = match params.first() {
                Some(Bind::Text(text)) => text.clone(),
                _ => String::new(),
            };
            if sql.contains("parent_id") {
                let ids = self.children.lock().get(&id).cloned().unwrap_or_default();
                let nodes = self.nodes.lock();
                let rows = ids
                    .iter()
                    .filter_map(|child| nodes.get(child).map(node_row))
                    .collect();
                return Ok(packed(rows));
            }
            if sql.contains("ros_summary_sources") {
                let rows = self
                    .sources
                    .lock()
                    .get(&id)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|message| source_row(&message))
                    .collect();
                return Ok(packed(rows));
            }
            let rows = self
                .nodes
                .lock()
                .get(&id)
                .map(node_row)
                .into_iter()
                .collect();
            Ok(packed(rows))
        }

        async fn connect(&self) -> Result<Idle, DbFail> {
            Ok(Idle)
        }
    }

    fn packed(rows: Vec<HashMap<String, Cell>>) -> QueryResult {
        let row_count = i64::try_from(rows.len()).unwrap_or(i64::MAX);
        QueryResult { rows, row_count }
    }

    fn stamp() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap()
    }

    fn node(id: &str, content: &str) -> SummaryNode {
        SummaryNode {
            summary_id: id.to_string(),
            conversation_id: None,
            kind: "summary".to_string(),
            depth: 1,
            content: content.to_string(),
            message_count: 1,
            earliest_at: None,
            latest_at: None,
            created_at: stamp(),
            model: None,
            access_count: 0,
        }
    }

    fn node_row(node: &SummaryNode) -> HashMap<String, Cell> {
        let mut row = HashMap::new();
        row.insert("id".to_string(), Cell::Text(node.summary_id.clone()));
        row.insert("kind".to_string(), Cell::Text(node.kind.clone()));
        row.insert("depth".to_string(), Cell::I64(node.depth));
        row.insert("content".to_string(), Cell::Text(node.content.clone()));
        row.insert("message_count".to_string(), Cell::I64(node.message_count));
        row.insert(
            "created_at".to_string(),
            Cell::Text("2026-08-01T12:00:00.000Z".to_string()),
        );
        row.insert("access_count".to_string(), Cell::I64(node.access_count));
        row
    }

    fn source_row(message: &SourceMessage) -> HashMap<String, Cell> {
        let mut row = HashMap::new();
        row.insert("id".to_string(), Cell::Text(message.message_id.clone()));
        row.insert("role".to_string(), Cell::Text(message.role.clone()));
        row.insert("content".to_string(), Cell::Text(message.content.clone()));
        row.insert(
            "created_at".to_string(),
            Cell::Text("2026-08-01T12:00:00.000Z".to_string()),
        );
        row
    }

    fn db() -> MemDb {
        let mut nodes = HashMap::new();
        nodes.insert("root".to_string(), node("root", "root summary"));
        nodes.insert("child".to_string(), node("child", "child summary"));
        let mut children = HashMap::new();
        children.insert("root".to_string(), vec!["child".to_string()]);
        let mut sources = HashMap::new();
        sources.insert(
            "root".to_string(),
            vec![SourceMessage {
                message_id: "m-root".to_string(),
                role: "user".to_string(),
                content: "root source message that is definitely long enough".to_string(),
                created_at: stamp(),
            }],
        );
        sources.insert(
            "child".to_string(),
            vec![
                SourceMessage {
                    message_id: "m-child".to_string(),
                    role: "user".to_string(),
                    content: "child source message that is definitely long enough".to_string(),
                    created_at: stamp(),
                },
                SourceMessage {
                    message_id: "m-tool".to_string(),
                    role: "tool".to_string(),
                    content: "tool output that is definitely long enough to be filtered"
                        .to_string(),
                    created_at: stamp(),
                },
                SourceMessage {
                    message_id: "m-short".to_string(),
                    role: "user".to_string(),
                    content: "short".to_string(),
                    created_at: stamp(),
                },
            ],
        );
        MemDb {
            nodes: Arc::new(Mutex::new(nodes)),
            children: Arc::new(Mutex::new(children)),
            sources: Arc::new(Mutex::new(sources)),
            fail: Arc::new(Mutex::new(false)),
        }
    }

    #[tokio::test]
    async fn expand_deep_collects_child_sources_and_stops_at_depth() {
        let expander = Expander::new(db());
        let shallow = expander
            .expand_deep("root", 1)
            .await
            .expect("expand")
            .expect("row");
        assert_eq!(shallow.source_messages.len(), 1);
        let deep = expander
            .expand_deep("root", 2)
            .await
            .expect("expand")
            .expect("row");
        assert_eq!(deep.children.len(), 1);
        assert_eq!(deep.source_messages.len(), 4);
        assert!(
            expander
                .expand_deep("missing", 3)
                .await
                .expect("ok")
                .is_none()
        );
    }

    #[tokio::test]
    async fn auto_expand_uses_score_depth_and_swallows_errors() {
        assert_eq!(expand_depth(0.5), 2);
        assert_eq!(expand_depth(0.51), 3);
        let store = db();
        let expander = Expander::new(store.clone());
        let mut high = SearchHit {
            id: "root".to_string(),
            hit_type: "summary".to_string(),
            content: "root summary".to_string(),
            role: "summary".to_string(),
            agent: "summary".to_string(),
            conversation_id: String::new(),
            score: 0.8,
            created_at: stamp(),
            truncated: false,
            full_length: None,
            tool_name: None,
            tool_result: None,
            kind: Some("summary".to_string()),
            earliest_at: None,
            latest_at: None,
            fallback: None,
            degraded: None,
            chunk_arm: None,
            snippet: None::<SearchSnippet>,
        };
        let low = SearchHit {
            score: 0.2,
            id: "child".to_string(),
            ..high.clone()
        };
        let message = SearchHit {
            hit_type: "message".to_string(),
            id: "m".to_string(),
            ..high.clone()
        };
        let expanded = auto_expand_summaries(&expander, &[message, high.clone(), low]).await;
        assert_eq!(expanded.len(), 2);
        assert_eq!(expanded[0].depth, 3);
        assert_eq!(expanded[0].source_messages.len(), 4);
        let kept = substantive_source_messages(&expanded[0].source_messages);
        assert!(
            kept.iter()
                .all(|message| message.role != "tool" && message.content != "short")
        );
        *store.fail.lock() = true;
        high.id = "root".to_string();
        let failed = auto_expand_summaries(&expander, &[high]).await;
        assert!(failed[0].children.is_empty());
    }
}
