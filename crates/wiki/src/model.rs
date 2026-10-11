use protocol::js::{JsObject, JsValue};

use crate::text::JsText;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};

#[derive(Clone, Debug)]
pub struct Passthrough {
    value: JsValue,
}

impl PartialEq for Passthrough {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl Passthrough {
    pub fn null() -> Self {
        Self {
            value: JsValue::Null,
        }
    }

    pub fn bool(value: bool) -> Self {
        Self {
            value: JsValue::Bool(value),
        }
    }

    pub fn number(value: f64) -> Self {
        Self {
            value: JsValue::Number(value),
        }
    }

    pub fn string(text: impl AsRef<str>) -> Self {
        Self {
            value: JsValue::from_text(text.as_ref()),
        }
    }

    pub fn array(items: Vec<Passthrough>) -> Self {
        Self {
            value: JsValue::Array(items.into_iter().map(|item| item.value).collect()),
        }
    }

    pub fn object<I, K>(entries: I) -> Self
    where
        I: IntoIterator<Item = (K, Passthrough)>,
        K: Into<protocol::js::JsString>,
    {
        let mut object = JsObject::new();
        for (key, value) in entries {
            object.insert(key, value.value);
        }
        Self::from_object(object)
    }

    pub(crate) fn from_object(object: JsObject) -> Self {
        Self {
            value: JsValue::Object(object),
        }
    }

    pub(crate) fn from_js(value: JsValue) -> Self {
        Self { value }
    }

    pub fn get(&self, key: &str) -> Option<Passthrough> {
        self.value.get(key).cloned().map(Self::from_js)
    }

    pub fn as_str(&self) -> Option<&str> {
        self.value.as_str()
    }

    pub fn as_f64(&self) -> Option<f64> {
        self.value.as_f64()
    }

    pub fn as_array(&self) -> Option<&[JsValue]> {
        self.value.as_array()
    }

    pub fn as_object(&self) -> Option<&JsObject> {
        self.value.as_object()
    }

    pub(crate) fn as_object_mut(&mut self) -> Option<&mut JsObject> {
        self.value.as_object_mut()
    }

    pub(crate) fn js(&self) -> &JsValue {
        &self.value
    }

    pub(crate) fn into_js(self) -> JsValue {
        self.value
    }

    #[cfg(test)]
    pub(crate) fn from_json(value: &serde_json::Value) -> Self {
        Self::from_js(json_to_js(value))
    }
}

#[cfg(test)]
fn json_to_js(value: &serde_json::Value) -> JsValue {
    match value {
        serde_json::Value::Null => JsValue::Null,
        serde_json::Value::Bool(bit) => JsValue::Bool(*bit),
        serde_json::Value::Number(number) => match number.as_f64() {
            Some(value) => JsValue::Number(value),
            None => JsValue::Null,
        },
        serde_json::Value::String(text) => JsValue::from_text(text),
        serde_json::Value::Array(items) => JsValue::Array(items.iter().map(json_to_js).collect()),
        serde_json::Value::Object(map) => {
            let mut object = JsObject::new();
            for (key, item) in map {
                object.insert(key.clone(), json_to_js(item));
            }
            JsValue::Object(object)
        }
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
            raw: Passthrough::object([
                ("kind", Passthrough::string("summary")),
                ("ids", Passthrough::array(items)),
            ]),
        }
    }

    pub(crate) fn from_value(value: &JsValue) -> Option<Self> {
        if value.as_object().is_none() || value.get("ids").and_then(JsValue::as_array).is_none() {
            return None;
        }
        Some(Self {
            raw: Passthrough::from_js(value.clone()),
        })
    }

    pub(crate) fn raw(&self) -> &Passthrough {
        &self.raw
    }

    pub fn kind(&self) -> Option<&str> {
        self.raw.js().get("kind").and_then(JsValue::as_str)
    }

    pub fn ids(&self) -> Vec<String> {
        self.raw
            .js()
            .get("ids")
            .and_then(JsValue::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(JsValue::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn conversation_id(&self) -> Option<&str> {
        self.raw
            .js()
            .get("conversationId")
            .and_then(JsValue::as_str)
    }

    pub fn span(&self) -> Option<SourceSpan> {
        let span = self.raw.js().get("span")?;
        let entries = span.as_object()?;
        if entries.len() != 2 {
            return None;
        }
        let earliest = span.get("earliest").and_then(JsValue::as_str)?;
        let latest = span.get("latest").and_then(JsValue::as_str)?;
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
        self.insert("ids", Passthrough::array(items));
    }

    pub fn set_conversation_id(&mut self, id: impl Into<String>) {
        self.insert("conversationId", Passthrough::string(id.into()));
    }

    pub fn set_span(&mut self, earliest: impl Into<String>, latest: impl Into<String>) {
        let earliest = earliest.into();
        let latest = latest.into();
        let updated = if let Some(span) = self
            .raw
            .as_object_mut()
            .and_then(|object| object.get_mut("span"))
            .and_then(JsValue::as_object_mut)
        {
            span.insert("earliest", JsValue::from_text(&earliest));
            span.insert("latest", JsValue::from_text(&latest));
            true
        } else {
            false
        };
        if updated {
            return;
        }
        self.insert(
            "span",
            Passthrough::object([
                ("earliest", Passthrough::string(earliest)),
                ("latest", Passthrough::string(latest)),
            ]),
        );
    }

    fn insert(&mut self, key: &str, value: Passthrough) {
        if let Some(object) = self.raw.as_object_mut() {
            object.insert(key, value.into_js());
            return;
        }
        self.raw = Passthrough::object([(key, value)]);
    }
}

impl Serialize for WikiSource {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.raw.js().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for WikiSource {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        let value = protocol::js::parse(raw.get()).map_err(de::Error::custom)?;
        let source = Self::from_value(&value)
            .ok_or_else(|| de::Error::custom("wiki source requires an ids array"))?;
        Ok(source)
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
    pub body: JsText,
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
    pub current_state: JsText,
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
    pub kept: JsText,
    pub overflow: JsText,
}
