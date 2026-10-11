use std::str::FromStr;

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum Passthrough {
    Value(protocol::js::JsValue),
    Array(Vec<Passthrough>),
    Object(Vec<(String, Passthrough)>),
}

impl Passthrough {
    pub fn null() -> Self {
        Self::Value(protocol::js::JsValue::Null)
    }

    pub fn bool(value: bool) -> Self {
        Self::Value(protocol::js::JsValue::Bool(value))
    }

    pub fn number(value: f64) -> Self {
        Self::Value(protocol::js::JsValue::Number(value))
    }

    pub fn string(text: impl AsRef<str>) -> Self {
        Self::Value(protocol::js::JsValue::from_text(text.as_ref()))
    }

    pub fn get(&self, key: &str) -> Option<&Self> {
        let Self::Object(entries) = self else {
            return None;
        };
        entries
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Value(protocol::js::JsValue::String(text)) => Some(text.to_utf8()),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Value(protocol::js::JsValue::Number(value)) => Some(*value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Self)]> {
        match self {
            Self::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub(crate) fn from_json(value: &Value) -> Self {
        match value {
            Value::Null => Self::null(),
            Value::Bool(bit) => Self::bool(*bit),
            Value::Number(number) => Self::number(number.as_f64().unwrap_or(0.0)),
            Value::String(text) => Self::string(text),
            Value::Array(items) => Self::Array(items.iter().map(Self::from_json).collect()),
            Value::Object(map) => Self::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), Self::from_json(item)))
                    .collect(),
            ),
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        match self {
            Self::Value(protocol::js::JsValue::Null) => Value::Null,
            Self::Value(protocol::js::JsValue::Bool(bit)) => Value::Bool(*bit),
            Self::Value(protocol::js::JsValue::Number(number)) => number_to_json(*number),
            Self::Value(protocol::js::JsValue::String(text)) => {
                Value::String(text.to_utf8().to_string())
            }
            Self::Value(protocol::js::JsValue::Array(items)) => Value::Array(
                items
                    .iter()
                    .map(|item| Self::Value(item.clone()).to_json())
                    .collect(),
            ),
            Self::Value(protocol::js::JsValue::Object(object)) => {
                let mut map = Map::new();
                for (key, value) in object.iter() {
                    map.insert(
                        key.to_utf8().to_string(),
                        Self::Value(value.clone()).to_json(),
                    );
                }
                Value::Object(map)
            }
            Self::Array(items) => Value::Array(items.iter().map(Self::to_json).collect()),
            Self::Object(entries) => {
                let mut map = Map::new();
                for (key, value) in entries {
                    map.insert(key.clone(), value.to_json());
                }
                Value::Object(map)
            }
        }
    }

    pub(crate) fn to_js(&self) -> protocol::js::JsValue {
        let json = self.to_json();
        match serde_json::to_string(&json) {
            Ok(text) => protocol::js::parse(&text).unwrap_or(protocol::js::JsValue::Null),
            Err(_) => protocol::js::JsValue::Null,
        }
    }
}

fn number_to_json(number: f64) -> Value {
    if !number.is_finite() {
        return Value::Null;
    }
    let text = protocol::JsNumber::from(number).to_string();
    match serde_json::Number::from_str(&text) {
        Ok(parsed) => Value::Number(parsed),
        Err(_) => Value::Null,
    }
}

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

#[derive(Clone, Debug, PartialEq)]
pub struct WikiSource {
    raw: Passthrough,
}

impl WikiSource {
    pub fn summary(ids: Vec<String>) -> Self {
        let items = ids.into_iter().map(Passthrough::string).collect();
        Self {
            raw: Passthrough::Object(vec![
                ("kind".to_string(), Passthrough::string("summary")),
                ("ids".to_string(), Passthrough::Array(items)),
            ]),
        }
    }

    pub(crate) fn from_passthrough(value: &Passthrough) -> Option<Self> {
        if value.as_object().is_none() || value.get("ids").and_then(Passthrough::as_array).is_none()
        {
            return None;
        }
        Some(Self { raw: value.clone() })
    }

    pub(crate) fn raw(&self) -> &Passthrough {
        &self.raw
    }

    pub fn kind(&self) -> Option<&str> {
        self.raw.get("kind").and_then(Passthrough::as_str)
    }

    pub fn ids(&self) -> Vec<String> {
        self.raw
            .get("ids")
            .and_then(Passthrough::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Passthrough::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn conversation_id(&self) -> Option<&str> {
        self.raw.get("conversationId").and_then(Passthrough::as_str)
    }

    pub fn span(&self) -> Option<SourceSpan> {
        let span = self.raw.get("span")?;
        let entries = span.as_object()?;
        if entries.len() != 2 {
            return None;
        }
        let earliest = span.get("earliest").and_then(Passthrough::as_str)?;
        let latest = span.get("latest").and_then(Passthrough::as_str)?;
        Some(SourceSpan {
            earliest: earliest.to_string(),
            latest: latest.to_string(),
        })
    }

    pub fn set_kind(&mut self, kind: impl Into<String>) {
        self.insert("kind", Passthrough::string(kind.into()));
    }

    pub fn set_ids(&mut self, ids: Vec<String>) {
        let items = ids.into_iter().map(Passthrough::string).collect();
        self.insert("ids", Passthrough::Array(items));
    }

    pub fn set_conversation_id(&mut self, id: impl Into<String>) {
        self.insert("conversationId", Passthrough::string(id.into()));
    }

    pub fn set_span(&mut self, earliest: impl Into<String>, latest: impl Into<String>) {
        self.insert(
            "span",
            Passthrough::Object(vec![
                ("earliest".to_string(), Passthrough::string(earliest.into())),
                ("latest".to_string(), Passthrough::string(latest.into())),
            ]),
        );
    }

    fn insert(&mut self, key: &str, value: Passthrough) {
        let Passthrough::Object(entries) = &mut self.raw else {
            self.raw = Passthrough::Object(vec![(key.to_string(), value)]);
            return;
        };
        if let Some((_, slot)) = entries.iter_mut().find(|(existing, _)| existing == key) {
            *slot = value;
        } else {
            entries.push((key.to_string(), value));
        }
    }
}

impl Serialize for WikiSource {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.raw.to_json().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for WikiSource {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let raw = Passthrough::from_json(&value);
        if raw.as_object().is_none() || raw.get("ids").and_then(Passthrough::as_array).is_none() {
            return Err(de::Error::custom("wiki source requires an ids array"));
        }
        Ok(Self { raw })
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
    pub extra: Option<Passthrough>,
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
