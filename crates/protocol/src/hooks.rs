use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HookEventName {
    #[serde(rename = "provider:before")]
    ProviderBefore,
    #[serde(rename = "provider:after")]
    ProviderAfter,
    #[serde(rename = "provider:error")]
    ProviderError,
    #[serde(rename = "tool:before")]
    ToolBefore,
    #[serde(rename = "tool:after")]
    ToolAfter,
    #[serde(rename = "session:start")]
    SessionStart,
    #[serde(rename = "session:end")]
    SessionEnd,
    #[serde(rename = "turn:before")]
    TurnBefore,
    #[serde(rename = "turn:after")]
    TurnAfter,
    #[serde(rename = "turn:reflect")]
    TurnReflect,
    #[serde(rename = "skill:before")]
    SkillBefore,
    #[serde(rename = "skill:after")]
    SkillAfter,
    #[serde(rename = "compact:before")]
    CompactBefore,
    #[serde(rename = "compact:after")]
    CompactAfter,
    #[serde(rename = "delegation:before")]
    DelegationBefore,
    #[serde(rename = "delegation:after")]
    DelegationAfter,
}

impl HookEventName {
    pub const ALL: [HookEventName; 16] = [
        HookEventName::ProviderBefore,
        HookEventName::ProviderAfter,
        HookEventName::ProviderError,
        HookEventName::ToolBefore,
        HookEventName::ToolAfter,
        HookEventName::SessionStart,
        HookEventName::SessionEnd,
        HookEventName::TurnBefore,
        HookEventName::TurnAfter,
        HookEventName::TurnReflect,
        HookEventName::SkillBefore,
        HookEventName::SkillAfter,
        HookEventName::CompactBefore,
        HookEventName::CompactAfter,
        HookEventName::DelegationBefore,
        HookEventName::DelegationAfter,
    ];
}
