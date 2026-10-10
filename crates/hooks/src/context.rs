use protocol::{HookEventName, ToolResult};
use serde_json::{Map, Value};

use crate::time_format::epoch_ms;

#[derive(Debug, Clone, PartialEq)]
pub struct PromptUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTokenTotals {
    pub prompt: i64,
    pub completion: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelegationStatus {
    Completed,
    Failed,
    Timeout,
    Cached,
}

impl DelegationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Timeout => "timeout",
            Self::Cached => "cached",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReflectSource {
    Complexity,
    Periodic,
    Manual,
}

impl ReflectSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complexity => "complexity",
            Self::Periodic => "periodic",
            Self::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnComplexity {
    pub tool_call_count: i64,
    pub had_error_recovery: bool,
    pub had_user_correction: bool,
    pub unique_tools: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HookContext {
    pub event: HookEventName,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub timestamp: i64,
    pub metadata: Map<String, Value>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub messages: Option<Vec<Value>>,
    pub tools: Option<Vec<Value>>,
    pub skip: Option<bool>,
    pub prompt_usage: Option<PromptUsage>,
    pub latency_ms: Option<i64>,
    pub has_tool_calls: Option<bool>,
    pub error_message: Option<String>,
    pub status_code: Option<i64>,
    pub tool_name: Option<String>,
    pub args: Option<Map<String, Value>>,
    pub blocked: Option<bool>,
    pub block_reason: Option<String>,
    pub result: Option<ToolResult>,
    pub duration_ms: Option<i64>,
    pub is_error: Option<bool>,
    pub platform: Option<String>,
    pub user_id: Option<String>,
    pub turn_count: Option<i64>,
    pub total_tokens: Option<SessionTokenTotals>,
    pub user_message: Option<String>,
    pub skip_reason: Option<String>,
    pub response: Option<String>,
    pub tools_used: Option<Vec<String>>,
    pub iterations: Option<i64>,
    pub aborted: Option<bool>,
    pub message_count: Option<i64>,
    pub remaining_messages: Option<i64>,
    pub summary: Option<String>,
    pub from_agent: Option<String>,
    pub to_agent: Option<String>,
    pub task: Option<String>,
    pub chain_depth: Option<i64>,
    pub delegation_status: Option<DelegationStatus>,
    pub cached: Option<bool>,
    pub complexity: Option<TurnComplexity>,
    pub reflect_source: Option<ReflectSource>,
    pub skill_name: Option<String>,
    pub skill_location: Option<String>,
    pub matched_triggers: Option<Vec<String>>,
    pub match_score: Option<f64>,
    pub skill_success: Option<bool>,
}

impl HookContext {
    pub fn new(event: HookEventName) -> Self {
        Self {
            event,
            agent_id: None,
            session_id: None,
            timestamp: epoch_ms(),
            metadata: Map::new(),
            provider_id: None,
            model: None,
            messages: None,
            tools: None,
            skip: None,
            prompt_usage: None,
            latency_ms: None,
            has_tool_calls: None,
            error_message: None,
            status_code: None,
            tool_name: None,
            args: None,
            blocked: None,
            block_reason: None,
            result: None,
            duration_ms: None,
            is_error: None,
            platform: None,
            user_id: None,
            turn_count: None,
            total_tokens: None,
            user_message: None,
            skip_reason: None,
            response: None,
            tools_used: None,
            iterations: None,
            aborted: None,
            message_count: None,
            remaining_messages: None,
            summary: None,
            from_agent: None,
            to_agent: None,
            task: None,
            chain_depth: None,
            delegation_status: None,
            cached: None,
            complexity: None,
            reflect_source: None,
            skill_name: None,
            skill_location: None,
            matched_triggers: None,
            match_score: None,
            skill_success: None,
        }
    }

    pub fn with_timestamp(mut self, timestamp: i64) -> Self {
        self.timestamp = timestamp;
        self
    }

    pub fn with_agent(mut self, agent_id: impl Into<String>) -> Self {
        self.agent_id = Some(agent_id.into());
        self
    }

    pub fn with_session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    pub fn provider_before(
        provider_id: impl Into<String>,
        model: impl Into<String>,
        messages: Vec<Value>,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::ProviderBefore);
        ctx.provider_id = Some(provider_id.into());
        ctx.model = Some(model.into());
        ctx.messages = Some(messages);
        ctx
    }

    pub fn provider_after(
        provider_id: impl Into<String>,
        model: impl Into<String>,
        latency_ms: i64,
        has_tool_calls: bool,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::ProviderAfter);
        ctx.provider_id = Some(provider_id.into());
        ctx.model = Some(model.into());
        ctx.latency_ms = Some(latency_ms);
        ctx.has_tool_calls = Some(has_tool_calls);
        ctx
    }

    pub fn provider_error(
        provider_id: impl Into<String>,
        model: impl Into<String>,
        error_message: impl Into<String>,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::ProviderError);
        ctx.provider_id = Some(provider_id.into());
        ctx.model = Some(model.into());
        ctx.error_message = Some(error_message.into());
        ctx
    }

    pub fn tool_before(tool_name: impl Into<String>, args: Map<String, Value>) -> Self {
        let mut ctx = Self::new(HookEventName::ToolBefore);
        ctx.tool_name = Some(tool_name.into());
        ctx.args = Some(args);
        ctx
    }

    pub fn tool_after(
        tool_name: impl Into<String>,
        args: Map<String, Value>,
        result: ToolResult,
        duration_ms: i64,
        is_error: bool,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::ToolAfter);
        ctx.tool_name = Some(tool_name.into());
        ctx.args = Some(args);
        ctx.result = Some(result);
        ctx.duration_ms = Some(duration_ms);
        ctx.is_error = Some(is_error);
        ctx
    }

    pub fn session_start() -> Self {
        Self::new(HookEventName::SessionStart)
    }

    pub fn session_end() -> Self {
        Self::new(HookEventName::SessionEnd)
    }

    pub fn turn_before(user_message: impl Into<String>) -> Self {
        let mut ctx = Self::new(HookEventName::TurnBefore);
        ctx.user_message = Some(user_message.into());
        ctx
    }

    pub fn turn_after(
        response: impl Into<String>,
        tools_used: Vec<String>,
        iterations: i64,
        aborted: bool,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::TurnAfter);
        ctx.response = Some(response.into());
        ctx.tools_used = Some(tools_used);
        ctx.iterations = Some(iterations);
        ctx.aborted = Some(aborted);
        ctx
    }

    pub fn turn_reflect(
        response: impl Into<String>,
        tools_used: Vec<String>,
        iterations: i64,
        complexity: TurnComplexity,
        source: ReflectSource,
        user_message: impl Into<String>,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::TurnReflect);
        ctx.response = Some(response.into());
        ctx.tools_used = Some(tools_used);
        ctx.iterations = Some(iterations);
        ctx.complexity = Some(complexity);
        ctx.reflect_source = Some(source);
        ctx.user_message = Some(user_message.into());
        ctx
    }

    pub fn skill_before(
        skill_name: impl Into<String>,
        skill_location: impl Into<String>,
        matched_triggers: Vec<String>,
        match_score: f64,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::SkillBefore);
        ctx.skill_name = Some(skill_name.into());
        ctx.skill_location = Some(skill_location.into());
        ctx.matched_triggers = Some(matched_triggers);
        ctx.match_score = Some(match_score);
        ctx
    }

    pub fn skill_after(
        skill_name: impl Into<String>,
        success: bool,
        tools_used: Vec<String>,
        iterations: i64,
        duration_ms: i64,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::SkillAfter);
        ctx.skill_name = Some(skill_name.into());
        ctx.skill_success = Some(success);
        ctx.tools_used = Some(tools_used);
        ctx.iterations = Some(iterations);
        ctx.duration_ms = Some(duration_ms);
        ctx
    }

    pub fn compact_before(message_count: i64) -> Self {
        let mut ctx = Self::new(HookEventName::CompactBefore);
        ctx.message_count = Some(message_count);
        ctx
    }

    pub fn compact_after(remaining_messages: i64) -> Self {
        let mut ctx = Self::new(HookEventName::CompactAfter);
        ctx.remaining_messages = Some(remaining_messages);
        ctx
    }

    pub fn delegation_before(
        from_agent: impl Into<String>,
        to_agent: impl Into<String>,
        task: impl Into<String>,
        chain_depth: i64,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::DelegationBefore);
        ctx.from_agent = Some(from_agent.into());
        ctx.to_agent = Some(to_agent.into());
        ctx.task = Some(task.into());
        ctx.chain_depth = Some(chain_depth);
        ctx
    }

    pub fn delegation_after(
        from_agent: impl Into<String>,
        to_agent: impl Into<String>,
        task: impl Into<String>,
        status: DelegationStatus,
        duration_ms: i64,
        cached: bool,
    ) -> Self {
        let mut ctx = Self::new(HookEventName::DelegationAfter);
        ctx.from_agent = Some(from_agent.into());
        ctx.to_agent = Some(to_agent.into());
        ctx.task = Some(task.into());
        ctx.delegation_status = Some(status);
        ctx.duration_ms = Some(duration_ms);
        ctx.cached = Some(cached);
        ctx
    }
}

#[cfg(test)]
mod tests {
    use super::{DelegationStatus, HookContext, ReflectSource, TurnComplexity};
    use protocol::{HookEventName, ToolResult};
    use serde_json::{Map, Value};

    #[test]
    fn constructors_set_the_event_and_its_fields() {
        let stamped = HookContext::new(HookEventName::ProviderBefore)
            .with_timestamp(7)
            .with_agent("opus")
            .with_session("sess");
        assert_eq!(stamped.timestamp, 7);
        assert_eq!(stamped.agent_id.as_deref(), Some("opus"));
        assert_eq!(stamped.session_id.as_deref(), Some("sess"));
        assert_eq!(
            HookContext::provider_before("google", "gemini", vec![Value::Null]).event,
            HookEventName::ProviderBefore
        );
        assert_eq!(
            HookContext::provider_after("google", "gemini", 3, true).has_tool_calls,
            Some(true)
        );
        assert_eq!(
            HookContext::provider_error("google", "gemini", "boom").error_message.as_deref(),
            Some("boom")
        );
        assert_eq!(
            HookContext::tool_before("shell", Map::new()).tool_name.as_deref(),
            Some("shell")
        );
        assert_eq!(
            HookContext::tool_after("shell", Map::new(), ToolResult::Text("ok".to_string()), 4, false)
                .duration_ms,
            Some(4)
        );
        assert_eq!(HookContext::session_start().event, HookEventName::SessionStart);
        assert_eq!(HookContext::session_end().event, HookEventName::SessionEnd);
        assert_eq!(
            HookContext::turn_before("hi").user_message.as_deref(),
            Some("hi")
        );
        assert_eq!(
            HookContext::turn_after("out", vec!["shell".to_string()], 2, false).iterations,
            Some(2)
        );
        let reflected = HookContext::turn_reflect(
            "out",
            vec!["shell".to_string()],
            1,
            TurnComplexity {
                tool_call_count: 1,
                had_error_recovery: false,
                had_user_correction: true,
                unique_tools: vec!["shell".to_string()],
            },
            ReflectSource::Manual,
            "hi",
        );
        assert_eq!(reflected.event, HookEventName::TurnReflect);
        assert_eq!(reflected.reflect_source, Some(ReflectSource::Manual));
        assert_eq!(ReflectSource::Complexity.as_str(), "complexity");
        assert_eq!(ReflectSource::Periodic.as_str(), "periodic");
        assert_eq!(
            HookContext::skill_before("name", "loc", vec!["go".to_string()], 0.5).match_score,
            Some(0.5)
        );
        assert_eq!(
            HookContext::skill_after("name", true, vec!["shell".to_string()], 1, 8).skill_success,
            Some(true)
        );
        assert_eq!(HookContext::compact_before(10).message_count, Some(10));
        assert_eq!(HookContext::compact_after(2).remaining_messages, Some(2));
        assert_eq!(
            HookContext::delegation_before("a", "b", "task", 1).chain_depth,
            Some(1)
        );
        let after = HookContext::delegation_after("a", "b", "task", DelegationStatus::Cached, 9, true);
        assert_eq!(after.delegation_status, Some(DelegationStatus::Cached));
        assert_eq!(DelegationStatus::Completed.as_str(), "completed");
        assert_eq!(DelegationStatus::Failed.as_str(), "failed");
        assert_eq!(DelegationStatus::Timeout.as_str(), "timeout");
        assert_eq!(after.cached, Some(true));
    }
}
