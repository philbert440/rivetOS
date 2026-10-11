crate::wire_enum! {
    pub enum HookEventName {
        ProviderBefore => "provider:before",
        ProviderAfter => "provider:after",
        ProviderError => "provider:error",
        ToolBefore => "tool:before",
        ToolAfter => "tool:after",
        SessionStart => "session:start",
        SessionEnd => "session:end",
        TurnBefore => "turn:before",
        TurnAfter => "turn:after",
        TurnReflect => "turn:reflect",
        SkillBefore => "skill:before",
        SkillAfter => "skill:after",
        CompactBefore => "compact:before",
        CompactAfter => "compact:after",
        DelegationBefore => "delegation:before",
        DelegationAfter => "delegation:after",
    }
}
