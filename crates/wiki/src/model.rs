use serde::Deserialize;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PatchAction {
    Create,
    Update,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArticlePatchMode {
    Merge,
    Replace,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSpan {
    pub earliest: String,
    pub latest: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WikiSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ids: Vec<String>,
    #[serde(
        default,
        rename = "conversationId",
        skip_serializing_if = "Option::is_none"
    )]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<SourceSpan>,
    #[serde(default, skip_serializing_if = "map_is_empty")]
    pub extra: Map<String, Value>,
}

fn map_is_empty(map: &Map<String, Value>) -> bool {
    map.is_empty()
}

impl WikiSource {
    pub fn summary(ids: Vec<String>) -> Self {
        Self {
            kind: Some("summary".to_string()),
            ids,
            conversation_id: None,
            span: None,
            extra: Map::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiCitation {
    pub summary_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiHistoryEntry {
    pub date: String,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiArticleSection {
    pub heading: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiArticlePatch {
    pub heading: String,
    pub mode: ArticlePatchMode,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WikiSection {
    pub heading: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WikiFrontmatter {
    pub title: String,
    pub slug: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub entities: Vec<String>,
    pub related: Vec<String>,
    pub last_verified: Option<String>,
    pub sources: Vec<WikiSource>,
    pub extra: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WikiPage {
    pub meta: WikiFrontmatter,
    pub current_state: String,
    pub article: String,
    pub history: Vec<WikiHistoryEntry>,
    pub citations: Vec<WikiCitation>,
    pub see_also: Vec<String>,
    pub preamble: Option<String>,
    pub extra_sections: Vec<WikiSection>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPatch {
    pub action: PatchAction,
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_entities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_related: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_delta: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub article: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub article_patches: Vec<WikiArticlePatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_entry: Option<WikiHistoryEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_sources: Vec<WikiSource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_citations: Vec<WikiCitation>,
    pub verified_at: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_shrink: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl WikiPatch {
    pub fn new(
        action: PatchAction,
        slug: impl Into<String>,
        verified_at: impl Into<String>,
    ) -> Self {
        Self {
            action,
            slug: slug.into(),
            title: None,
            add_aliases: Vec::new(),
            add_tags: Vec::new(),
            add_entities: Vec::new(),
            add_related: Vec::new(),
            current_state: None,
            summary_delta: None,
            article: None,
            article_patches: Vec::new(),
            history_entry: None,
            add_sources: Vec::new(),
            add_citations: Vec::new(),
            verified_at: verified_at.into(),
            allow_shrink: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SummaryCap {
    pub kept: String,
    pub overflow: String,
}
