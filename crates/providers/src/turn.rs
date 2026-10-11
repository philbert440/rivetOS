use futures_util::StreamExt;
use protocol::{LlmChunk, LlmChunkType, StreamEvent, ThinkingLevel};

use crate::error::ProviderError;
use crate::types::{
    ChatRequest, Provider, TURN_TIMEOUT_MS, TurnMessage, execute_tool, text_event,
    tool_result_event, tool_start_event, with_compact,
};
use std::time::Duration;

pub struct TurnOutput {
    pub chunks: Vec<LlmChunk>,
    pub events: Vec<StreamEvent>,
}

pub async fn run_agent_turn(
    provider: &dyn Provider,
    thinking: ThinkingLevel,
) -> Result<TurnOutput, ProviderError> {
    let tools = with_compact(vec![crate::types::echo_tool()]);
    let mut messages = vec![TurnMessage::User {
        text: "Say hi.".to_string(),
        parts: Vec::new(),
    }];
    let mut chunks = Vec::new();
    let mut events = Vec::new();
    let mut steps = 0u32;
    loop {
        if steps >= 50 {
            break;
        }
        let request = ChatRequest {
            system: "You are a test.".to_string(),
            messages: messages.clone(),
            tools: tools.clone(),
            thinking,
            session_id: Some("test-session".to_string()),
            conversation_key: None,
            model_override: None,
            timeout: Duration::from_millis(TURN_TIMEOUT_MS),
            contains_images: false,
        };
        let mut stream = provider.stream_chat(request).await?;
        while let Some(item) = stream.next().await {
            let chunk = item?;
            match chunk.r#type {
                LlmChunkType::Text => {
                    if let Some(delta) = chunk.delta.clone() {
                        events.push(text_event(protocol::StreamEventType::Text, delta));
                    }
                }
                LlmChunkType::Reasoning => {
                    if let Some(delta) = chunk.delta.clone() {
                        events.push(text_event(protocol::StreamEventType::Reasoning, delta));
                    }
                }
                _ => {}
            }
            chunks.push(chunk);
        }
        let capture = stream.capture.lock().clone();
        let replay = capture.replay_tools();
        if replay.is_empty() {
            break;
        }
        steps += 1;
        let mut results = Vec::new();
        for tool in &replay {
            events.push(tool_start_event(&tool.name, &tool.arguments));
            let (text, is_error) = execute_tool(&tool.name, &tool.arguments_json);
            events.push(tool_result_event(&tool.name, &text, is_error));
            results.push((tool.id.clone(), tool.name.clone(), text));
        }
        messages.push(TurnMessage::Assistant {
            text: capture.text,
            reasoning: capture.reasoning,
            anthropic_signature: capture.anthropic_signature,
            xai_reasoning_id: capture.xai_reasoning_id,
            tool_calls: replay,
        });
        for (id, name, content) in results {
            messages.push(TurnMessage::ToolResult {
                id,
                name,
                content,
                parts: Vec::new(),
            });
        }
    }
    Ok(TurnOutput { chunks, events })
}
