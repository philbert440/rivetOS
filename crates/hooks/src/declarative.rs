use protocol::{HookEventName, JsNumber};
use serde::{Deserialize, Serialize};

use crate::handler::HookErrorMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookConfigKind {
    Shell,
    Http,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookConfig {
    pub id: String,
    pub event: HookEventName,
    #[serde(rename = "type")]
    pub kind: HookConfigKind,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<JsNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<HookErrorMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_filter: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_filter: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::HookConfig;
    use protocol::JsNumber;

    #[test]
    fn declarative_hook_json_uses_javascript_field_names() {
        let parsed: HookConfig = serde_json::from_str(
            r#"{"id":"h","event":"tool:before","type":"shell","target":"echo hi","priority":10,"onError":"abort","agentFilter":["opus"],"toolFilter":["shell"],"description":"desc","enabled":false}"#,
        )
        .expect("parse");
        assert_eq!(parsed.kind, super::HookConfigKind::Shell);
        assert_eq!(parsed.priority, Some(JsNumber::from(10_i64)));
        assert_eq!(parsed.on_error, Some(super::HookErrorMode::Abort));
        let text = serde_json::to_string(&parsed).expect("json");
        assert!(text.contains("\"priority\":10"));
        assert!(!text.contains("10.0"));
        assert!(text.contains("\"type\":\"shell\""));
        assert!(text.contains("\"onError\":\"abort\""));
    }
}
