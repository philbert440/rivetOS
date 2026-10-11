use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

use crate::js::{JsObject, JsString, JsValue, parse};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPart {
    #[serde(rename = "type")]
    pub r#type: TextType,
    pub text: String,
}

crate::wire_enum! {
    pub enum TextType {
        Text => "text",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    #[serde(rename = "type")]
    pub r#type: ImageType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

crate::wire_enum! {
    pub enum ImageType {
        Image => "image",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPart {
    #[serde(rename = "type")]
    pub r#type: VideoType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

crate::wire_enum! {
    pub enum VideoType {
        Video => "video",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: JsString },
    #[serde(rename = "image")]
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    #[serde(rename = "video")]
    Video {
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
}

impl<'de> Deserialize<'de> for ContentPart {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        let value = parse(raw.get()).map_err(de::Error::custom)?;
        content_part_from_js(value).map_err(de::Error::custom)
    }
}

pub(crate) fn content_part_from_js(value: JsValue) -> Result<ContentPart, &'static str> {
    let mut object = match value.into_object() {
        Some(object) => object,
        None => return Err("content-part"),
    };
    let kind = match take_js_string(object.remove("type")) {
        Some(text) => text.to_utf8().to_string(),
        None => return Err("content-part"),
    };
    match kind.as_str() {
        "text" => {
            let text = match take_js_string(object.remove("text")) {
                Some(text) => text,
                None => return Err("content-part"),
            };
            Ok(ContentPart::Text { text })
        }
        "image" => Ok(ContentPart::Image {
            data: take_string(&mut object, "data")?,
            url: take_string(&mut object, "url")?,
            mime_type: take_string(&mut object, "mimeType")?,
        }),
        "video" => Ok(ContentPart::Video {
            data: take_string(&mut object, "data")?,
            url: take_string(&mut object, "url")?,
            mime_type: take_string(&mut object, "mimeType")?,
        }),
        _ => Err("content-part"),
    }
}

fn take_js_string(value: Option<JsValue>) -> Option<JsString> {
    let mut value = value?;
    if let JsValue::String(slot) = &mut value {
        Some(std::mem::replace(slot, JsString::from_units(Vec::new())))
    } else {
        None
    }
}

fn take_string(object: &mut JsObject, key: &str) -> Result<Option<String>, &'static str> {
    match object.remove(key) {
        None => Ok(None),
        Some(value) if value.is_null() => Ok(None),
        Some(value) => match take_js_string(Some(value)) {
            Some(text) => {
                let utf8 = text.to_utf8();
                let round: Vec<u16> = utf8.encode_utf16().collect();
                if round.as_slice() != text.units() {
                    return Err("content-part");
                }
                Ok(Some(utf8.to_string()))
            }
            None => Err("content-part"),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl<'de> Deserialize<'de> for MessageContent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        let mut value = parse(raw.get()).map_err(de::Error::custom)?;
        match &mut value {
            JsValue::String(slot) => {
                let text = std::mem::replace(slot, JsString::from_units(Vec::new()));
                match String::from_utf16(text.units()) {
                    Ok(utf8) => Ok(Self::Text(utf8)),
                    Err(_) => Err(de::Error::custom("message-content")),
                }
            }
            JsValue::Array(items) => {
                let items = std::mem::take(items);
                let mut parts = Vec::with_capacity(items.len());
                for item in items {
                    parts.push(content_part_from_js(item).map_err(de::Error::custom)?);
                }
                Ok(Self::Parts(parts))
            }
            _ => Err(de::Error::custom("message-content")),
        }
    }
}

crate::wire_enum! {
    pub enum MessageRole {
        System => "system",
        User => "user",
        Assistant => "assistant",
        Tool => "tool",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: JsObject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

impl ToolCall {
    pub fn argument(&self, key: &str) -> Option<&JsValue> {
        self.arguments.get(key)
    }

    pub fn arguments_json(&self) -> String {
        crate::js::stringify_object(&self.arguments)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: MessageRole,
    pub content: MessageContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}
