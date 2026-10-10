use protocol::js::js_trim;
use protocol::{Message, MessageContent, MessageRole};

pub const RECENT_ACTIVITY_HEADING: &str = "## Recent Activity (last 48h)";

pub const VOICE_MODE_PROMPT: &str = r#"

## VOICE MODE — these rules OVERRIDE all formatting guidance above
You are speaking OUT LOUD on a live voice call right now. Everything you write is read aloud by a text-to-speech voice. This is a phone conversation, not a chat message or a document.

HARD RULES:
- Answer in ONE or TWO short spoken sentences. Aim for under 40 words. Give the single key point, not an explanation.
- ZERO markdown or formatting. No #, no *, no -, no bullet points, no numbered lists, no headings, no code, no tables, no links, no emoji. Plain spoken words ONLY — anything else gets read aloud as gibberish.
- Do NOT structure or enumerate your answer. Do NOT write a report or summary document. Just say the one thing, the way you'd say it to a person standing next to you.
- If a full answer would be long, say the gist in one sentence and ask "want me to put the details in text?" — do NOT actually list them out loud.
Talk like a person on a phone, not like you're writing."#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnAssembly {
    pub system_prompt: String,
    pub recent_activity: Option<Message>,
    pub daily_context: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct TurnAssemblyInput<'a> {
    pub agent_id: Option<&'a str>,
    pub user_id: Option<&'a str>,
    pub chat_type: Option<&'a str>,
    pub extra_system_prompt: Option<&'a str>,
    pub recent_context: Option<&'a str>,
}

pub fn recent_activity_message(context: &str) -> Option<Message> {
    if js_trim(context).is_empty() {
        return None;
    }
    Some(Message {
        role: MessageRole::System,
        content: MessageContent::Text(format!("{RECENT_ACTIVITY_HEADING}\n{context}")),
        tool_calls: None,
        tool_call_id: None,
    })
}

pub(crate) fn apply_turn_extras(
    mut system_prompt: String,
    chat_type: Option<&str>,
    extra_system_prompt: Option<&str>,
) -> String {
    if chat_type == Some("voice") {
        system_prompt.push_str(VOICE_MODE_PROMPT);
    }
    if let Some(extra) = extra_system_prompt {
        let trimmed = js_trim(extra);
        if !trimmed.is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(trimmed);
        }
    }
    system_prompt
}

#[cfg(test)]
mod tests {
    use super::{
        RECENT_ACTIVITY_HEADING, VOICE_MODE_PROMPT, apply_turn_extras, recent_activity_message,
    };
    use protocol::{MessageContent, MessageRole};

    #[test]
    fn voice_prompt_matches_the_turn_handler_literal() {
        assert!(VOICE_MODE_PROMPT.starts_with(
            "\n\n## VOICE MODE — these rules OVERRIDE all formatting guidance above\n"
        ));
        assert!(VOICE_MODE_PROMPT.contains("want me to put the details in text?"));
        assert!(
            VOICE_MODE_PROMPT.ends_with("Talk like a person on a phone, not like you're writing.")
        );
        assert!(!VOICE_MODE_PROMPT.ends_with('\n'));
    }

    #[test]
    fn extras_append_voice_then_trimmed_preset() {
        let prompt = apply_turn_extras("base".to_string(), Some("voice"), Some("  be terse  "));
        assert_eq!(prompt, format!("base{VOICE_MODE_PROMPT}\n\nbe terse"));
        assert_eq!(
            apply_turn_extras("base".to_string(), Some("Voice"), Some("   ")),
            "base"
        );
        assert_eq!(
            apply_turn_extras(
                "base".to_string(),
                Some("dm"),
                Some("\u{00a0}be terse\u{00a0}")
            ),
            "base\n\nbe terse"
        );
    }

    #[test]
    fn recent_activity_keeps_untrimmed_text() {
        let message = recent_activity_message("  hi ").expect("context");
        assert_eq!(message.role, MessageRole::System);
        match message.content {
            MessageContent::Text(text) => {
                assert_eq!(text, format!("{RECENT_ACTIVITY_HEADING}\n  hi "));
            }
            MessageContent::Parts(_) => panic!("text content"),
        }
        assert!(recent_activity_message(" \n ").is_none());
        assert!(recent_activity_message("").is_none());
    }
}
