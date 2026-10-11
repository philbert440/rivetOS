use protocol::{JsNumber, LlmChunk, LlmChunkType, LlmUsage, PartialToolCall};
use serde_json::Value;

use crate::jsonutil::obj;

pub fn text_chunk(delta: &str) -> LlmChunk {
    LlmChunk {
        r#type: LlmChunkType::Text,
        delta: Some(delta.to_string()),
        tool_call: None,
        usage: None,
        citations: None,
        error: None,
    }
}

pub fn reasoning_chunk(delta: &str) -> LlmChunk {
    LlmChunk {
        r#type: LlmChunkType::Reasoning,
        delta: Some(delta.to_string()),
        tool_call: None,
        usage: None,
        citations: None,
        error: None,
    }
}

pub fn error_chunk(message: &str) -> LlmChunk {
    LlmChunk {
        r#type: LlmChunkType::Error,
        delta: None,
        tool_call: None,
        usage: None,
        citations: None,
        error: Some(message.to_string()),
    }
}

pub fn tool_start(index: u64, id: &str, name: &str) -> LlmChunk {
    LlmChunk {
        r#type: LlmChunkType::ToolCallStart,
        delta: None,
        tool_call: Some(partial(vec![
            ("index", Value::from(index)),
            ("id", Value::from(id)),
            ("name", Value::from(name)),
        ])),
        usage: None,
        citations: None,
        error: None,
    }
}

pub fn tool_delta(index: u64, delta: &str) -> LlmChunk {
    LlmChunk {
        r#type: LlmChunkType::ToolCallDelta,
        delta: Some(delta.to_string()),
        tool_call: Some(partial(vec![("index", Value::from(index))])),
        usage: None,
        citations: None,
        error: None,
    }
}

pub fn tool_done(index: u64) -> LlmChunk {
    LlmChunk {
        r#type: LlmChunkType::ToolCallDone,
        delta: None,
        tool_call: Some(partial(vec![("index", Value::from(index))])),
        usage: None,
        citations: None,
        error: None,
    }
}

pub fn done_chunk(usage: LlmUsage, citations: &[String]) -> LlmChunk {
    LlmChunk {
        r#type: LlmChunkType::Done,
        delta: None,
        tool_call: None,
        usage: Some(usage),
        citations: if citations.is_empty() {
            None
        } else {
            Some(citations.to_vec())
        },
        error: None,
    }
}

pub fn status_chunk(delta: &str) -> LlmChunk {
    LlmChunk {
        r#type: LlmChunkType::Status,
        delta: Some(delta.to_string()),
        tool_call: None,
        usage: None,
        citations: None,
        error: None,
    }
}

pub fn usage(
    prompt: u64,
    completion: u64,
    reasoning: Option<u64>,
    cached: Option<u64>,
) -> LlmUsage {
    LlmUsage {
        prompt_tokens: JsNumber::from(prompt),
        completion_tokens: JsNumber::from(completion),
        reasoning_tokens: reasoning.map(JsNumber::from),
        cached_tokens: cached.map(JsNumber::from),
        cache_creation_tokens: None,
        cache_read_tokens: None,
    }
}

fn partial(pairs: Vec<(&str, Value)>) -> PartialToolCall {
    match serde_json::from_value(obj(pairs)) {
        Ok(call) => call,
        Err(_) => PartialToolCall::new(),
    }
}
