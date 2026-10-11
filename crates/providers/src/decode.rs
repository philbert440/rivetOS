use std::collections::HashMap;
use std::sync::Arc;

use protocol::LlmChunk;
use serde_json::Value;

use crate::chunks::{reasoning_chunk, text_chunk, tool_delta, tool_done, tool_start};
use crate::http::WireDecoder;
use crate::jsonutil::{IdGen, canonical_from_value, canonical_json, str_field, u64_field};
use crate::sse::{NdjsonParser, SseParser};
use crate::types::{CapturedTool, StepCapture};

pub struct Decoder {
    kind: Kind,
    sse: SseParser,
    ndjson: NdjsonParser,
    ids: Arc<IdGen>,
    state: State,
    terminal: Option<crate::error::ProviderError>,
}

#[derive(Clone, Copy)]
pub enum Kind {
    Anthropic,
    Xai,
    Google,
    OpenAi,
    Ollama,
}

struct State {
    tools: Vec<ToolState>,
    by_block: HashMap<u64, usize>,
    by_item: HashMap<String, usize>,
    anthropic_prompt: u64,
    open_done: bool,
}

struct ToolState {
    index: u64,
    id: String,
    name: String,
    raw: String,
    signature: Option<String>,
    done: bool,
}

impl Decoder {
    pub fn new(kind: Kind, ids: Arc<IdGen>) -> Self {
        Self {
            kind,
            sse: SseParser::new(),
            ndjson: NdjsonParser::new(),
            ids,
            state: State {
                tools: Vec::new(),
                by_block: HashMap::new(),
                by_item: HashMap::new(),
                anthropic_prompt: 0,
                open_done: false,
            },
            terminal: None,
        }
    }
}

impl WireDecoder for Decoder {
    fn push(&mut self, bytes: &[u8], chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture) {
        match self.kind {
            Kind::Ollama => {
                for line in self.ndjson.push(bytes) {
                    self.on_ollama(&line, chunks, cap);
                }
            }
            _ => {
                for (event, data) in self.sse.push(bytes) {
                    self.on_sse(&event, &data, chunks, cap);
                }
            }
        }
    }

    fn finish(&mut self, chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture) {
        match self.kind {
            Kind::Ollama => {
                for line in self.ndjson.finish() {
                    self.on_ollama(&line, chunks, cap);
                }
            }
            _ => {
                for (event, data) in self.sse.finish() {
                    self.on_sse(&event, &data, chunks, cap);
                }
            }
        }
        self.close_open_tools(chunks, cap);
    }

    fn take_error(&mut self) -> Option<crate::error::ProviderError> {
        self.terminal.take()
    }
}

impl Decoder {
    fn on_sse(
        &mut self,
        event: &str,
        data: &str,
        chunks: &mut Vec<LlmChunk>,
        cap: &mut StepCapture,
    ) {
        let data = data.trim();
        if data.is_empty() {
            return;
        }
        if data == "[DONE]" {
            self.close_open_tools(chunks, cap);
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return;
        };
        match self.kind {
            Kind::Anthropic => self.on_anthropic(event, &value, chunks, cap),
            Kind::Xai => self.on_xai(event, &value, chunks, cap),
            Kind::Google => self.on_google(&value, chunks, cap),
            Kind::OpenAi => self.on_openai(&value, chunks, cap),
            Kind::Ollama => {}
        }
    }

    fn on_anthropic(
        &mut self,
        event: &str,
        value: &Value,
        chunks: &mut Vec<LlmChunk>,
        cap: &mut StepCapture,
    ) {
        let event_name = if event.is_empty() {
            str_field(value, "type")
        } else {
            event.to_string()
        };
        match event_name.as_str() {
            "message_start" => {
                if let Some(message) = value.get("message") {
                    let id = str_field(message, "id");
                    if !id.is_empty() {
                        cap.response_id = Some(id);
                    }
                    if let Some(usage) = message.get("usage") {
                        let input = u64_field(usage, "input_tokens").unwrap_or(0);
                        let cache_read = u64_field(usage, "cache_read_input_tokens").unwrap_or(0);
                        let cache_create =
                            u64_field(usage, "cache_creation_input_tokens").unwrap_or(0);
                        self.state.anthropic_prompt = input + cache_read + cache_create;
                        cap.prompt_tokens = self.state.anthropic_prompt;
                        if cache_read > 0 {
                            cap.cached_tokens = Some(cache_read);
                        }
                    }
                }
            }
            "content_block_start" => {
                let index = u64_field(value, "index").unwrap_or(0);
                let block = value.get("content_block").cloned().unwrap_or(Value::Null);
                if str_field(&block, "type") == "tool_use" {
                    let id = str_field(&block, "id");
                    let name = str_field(&block, "name");
                    let tool_index = self.state.tools.len() as u64;
                    self.state.by_block.insert(index, self.state.tools.len());
                    self.state.tools.push(ToolState {
                        index: tool_index,
                        id: id.clone(),
                        name: name.clone(),
                        raw: String::new(),
                        signature: None,
                        done: false,
                    });
                    self.sync_tools(cap);
                    chunks.push(tool_start(tool_index, &id, &name));
                }
            }
            "content_block_delta" => {
                let index = u64_field(value, "index").unwrap_or(0);
                let delta = value.get("delta").cloned().unwrap_or(Value::Null);
                match str_field(&delta, "type").as_str() {
                    "text_delta" => {
                        let text = str_field(&delta, "text");
                        if !text.is_empty() {
                            cap.text.push_str(&text);
                            cap.saw_text = true;
                            chunks.push(text_chunk(&text));
                        }
                    }
                    "thinking_delta" => {
                        let text = str_field(&delta, "thinking");
                        if !text.is_empty() {
                            cap.reasoning.push_str(&text);
                            chunks.push(reasoning_chunk(&text));
                        }
                    }
                    "signature_delta" => {
                        let signature = str_field(&delta, "signature");
                        if !signature.is_empty() {
                            cap.anthropic_signature = Some(signature);
                        }
                    }
                    "input_json_delta" => {
                        let partial = str_field(&delta, "partial_json");
                        if let Some(slot) = self.state.by_block.get(&index).copied() {
                            let emitted = self.state.tools.get_mut(slot).map(|tool| {
                                tool.raw.push_str(&partial);
                                if partial.is_empty() {
                                    None
                                } else {
                                    Some(tool.index)
                                }
                            });
                            self.sync_tools(cap);
                            if let Some(Some(index)) = emitted {
                                chunks.push(tool_delta(index, &partial));
                            }
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = u64_field(value, "index").unwrap_or(0);
                if let Some(slot) = self.state.by_block.get(&index).copied() {
                    self.finish_tool(slot, chunks, cap);
                }
            }
            "message_delta" => {
                if let Some(usage) = value.get("usage")
                    && let Some(output) = u64_field(usage, "output_tokens")
                {
                    cap.completion_tokens = output;
                }
                cap.prompt_tokens = self.state.anthropic_prompt;
            }
            "error" | "overloaded" => {
                let err_obj = value.get("error").unwrap_or(value);
                let kind = str_field(err_obj, "type");
                let message = str_field(err_obj, "message");
                let status = match kind.as_str() {
                    "overloaded_error" | "overloaded" => 529,
                    "rate_limit_error" => 429,
                    _ if event_name == "overloaded" => 529,
                    _ => 0,
                };
                let detail = if message.is_empty() {
                    if kind.is_empty() {
                        "stream error".to_string()
                    } else {
                        kind
                    }
                } else {
                    message
                };
                let status_text = if status == 0 {
                    detail
                } else {
                    format!("Anthropic {status}: {detail}")
                };
                self.terminal = Some(crate::error::ProviderError::new(
                    status_text,
                    status,
                    "anthropic",
                ));
            }
            _ => {}
        }
    }

    fn on_xai(
        &mut self,
        event: &str,
        value: &Value,
        chunks: &mut Vec<LlmChunk>,
        cap: &mut StepCapture,
    ) {
        let kind = if event.is_empty() {
            str_field(value, "type")
        } else {
            event.to_string()
        };
        match kind.as_str() {
            "response.output_text.delta" => {
                let text = str_field(value, "delta");
                if !text.is_empty() {
                    cap.text.push_str(&text);
                    cap.saw_text = true;
                    chunks.push(text_chunk(&text));
                }
            }
            "response.reasoning_summary_text.delta" => {
                let text = str_field(value, "delta");
                if !text.is_empty() {
                    cap.reasoning.push_str(&text);
                    chunks.push(reasoning_chunk(&text));
                }
            }
            "response.output_item.added" => {
                let item = value.get("item").cloned().unwrap_or(Value::Null);
                let item_type = str_field(&item, "type");
                if item_type == "reasoning" {
                    let id = str_field(&item, "id");
                    if !id.is_empty() {
                        cap.xai_reasoning_id = Some(id);
                    }
                } else if item_type == "function_call" {
                    let item_id = str_field(&item, "id");
                    let call_id = str_field(&item, "call_id");
                    let name = str_field(&item, "name");
                    let tool_index = self.state.tools.len() as u64;
                    let slot = self.state.tools.len();
                    if !item_id.is_empty() {
                        self.state.by_item.insert(item_id, slot);
                    }
                    self.state.tools.push(ToolState {
                        index: tool_index,
                        id: call_id.clone(),
                        name: name.clone(),
                        raw: String::new(),
                        signature: None,
                        done: false,
                    });
                    self.sync_tools(cap);
                    chunks.push(tool_start(tool_index, &call_id, &name));
                }
            }
            "response.function_call_arguments.delta" => {
                let item_id = str_field(value, "item_id");
                let partial = str_field(value, "delta");
                if let Some(slot) = self.state.by_item.get(&item_id).copied() {
                    let emitted = self.state.tools.get_mut(slot).map(|tool| {
                        tool.raw.push_str(&partial);
                        if partial.is_empty() {
                            None
                        } else {
                            Some(tool.index)
                        }
                    });
                    self.sync_tools(cap);
                    if let Some(Some(index)) = emitted {
                        chunks.push(tool_delta(index, &partial));
                    }
                }
            }
            "response.output_item.done" => {
                let item = value.get("item").cloned().unwrap_or(Value::Null);
                if str_field(&item, "type") == "function_call" {
                    let item_id = str_field(&item, "id");
                    if let Some(slot) = self.state.by_item.get(&item_id).copied() {
                        if let Some(arguments) = item.get("arguments").and_then(Value::as_str)
                            && let Some(tool) = self.state.tools.get_mut(slot)
                            && tool.raw.is_empty()
                        {
                            tool.raw = arguments.to_string();
                        }
                        self.finish_tool(slot, chunks, cap);
                    }
                } else if str_field(&item, "type") == "reasoning" {
                    let id = str_field(&item, "id");
                    if !id.is_empty() {
                        cap.xai_reasoning_id = Some(id);
                    }
                }
            }
            "response.completed" => {
                if let Some(response) = value.get("response")
                    && let Some(usage) = response.get("usage")
                {
                    cap.prompt_tokens =
                        u64_field(usage, "input_tokens").unwrap_or(cap.prompt_tokens);
                    cap.completion_tokens =
                        u64_field(usage, "output_tokens").unwrap_or(cap.completion_tokens);
                    if let Some(details) = usage.get("input_tokens_details")
                        && let Some(cached) = u64_field(details, "cached_tokens")
                        && cached > 0
                    {
                        cap.cached_tokens = Some(cached);
                    }
                    if let Some(details) = usage.get("output_tokens_details")
                        && let Some(reasoning) = u64_field(details, "reasoning_tokens")
                        && reasoning > 0
                    {
                        cap.reasoning_tokens = Some(reasoning);
                    }
                }
            }
            _ => {}
        }
    }

    fn on_google(&mut self, value: &Value, chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture) {
        if let Some(usage) = value.get("usageMetadata") {
            if let Some(prompt) = u64_field(usage, "promptTokenCount") {
                cap.prompt_tokens = prompt;
            }
            if let Some(completion) = u64_field(usage, "candidatesTokenCount") {
                cap.completion_tokens = completion;
            }
            if let Some(reasoning) = u64_field(usage, "thoughtsTokenCount")
                && reasoning > 0
            {
                cap.reasoning_tokens = Some(reasoning);
            }
            if let Some(cached) = u64_field(usage, "cachedContentTokenCount")
                && cached > 0
            {
                cap.cached_tokens = Some(cached);
            }
        }
        let Some(candidates) = value.get("candidates").and_then(Value::as_array) else {
            return;
        };
        for candidate in candidates {
            let Some(parts) = candidate
                .get("content")
                .and_then(|content| content.get("parts"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for part in parts {
                if let Some(call) = part.get("functionCall") {
                    let name = str_field(call, "name");
                    let args = call.get("args").cloned().unwrap_or(Value::Null);
                    let (raw, _) = canonical_from_value(&args);
                    let id = self.ids.next_id();
                    let signature = part
                        .get("thoughtSignature")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let tool_index = self.state.tools.len() as u64;
                    self.state.tools.push(ToolState {
                        index: tool_index,
                        id: id.clone(),
                        name: name.clone(),
                        raw: raw.clone(),
                        signature: signature.clone(),
                        done: true,
                    });
                    self.sync_tools(cap);
                    chunks.push(tool_start(tool_index, &id, &name));
                    chunks.push(tool_delta(tool_index, &raw));
                    chunks.push(tool_done(tool_index));
                } else if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if text.is_empty() {
                        continue;
                    }
                    let thought = part
                        .get("thought")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if thought {
                        cap.reasoning.push_str(text);
                        chunks.push(reasoning_chunk(text));
                    } else {
                        cap.text.push_str(text);
                        cap.saw_text = true;
                        chunks.push(text_chunk(text));
                    }
                }
            }
        }
    }

    fn on_openai(&mut self, value: &Value, chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture) {
        if let Some(usage) = value.get("usage") {
            if let Some(prompt) = u64_field(usage, "prompt_tokens") {
                cap.prompt_tokens = prompt;
            }
            if let Some(completion) = u64_field(usage, "completion_tokens") {
                cap.completion_tokens = completion;
            }
            if let Some(details) = usage.get("prompt_tokens_details")
                && let Some(cached) = u64_field(details, "cached_tokens")
                && cached > 0
            {
                cap.cached_tokens = Some(cached);
            }
            if let Some(details) = usage.get("completion_tokens_details")
                && let Some(reasoning) = u64_field(details, "reasoning_tokens")
                && reasoning > 0
            {
                cap.reasoning_tokens = Some(reasoning);
            }
        }
        let Some(choices) = value.get("choices").and_then(Value::as_array) else {
            return;
        };
        for choice in choices {
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str)
                && !reason.is_empty()
            {
                self.state.open_done = true;
            }
            let Some(delta) = choice.get("delta") else {
                continue;
            };
            if let Some(text) = delta.get("content").and_then(Value::as_str)
                && !text.is_empty()
            {
                cap.text.push_str(text);
                cap.saw_text = true;
                chunks.push(text_chunk(text));
            }
            if let Some(text) = delta.get("reasoning_content").and_then(Value::as_str)
                && !text.is_empty()
            {
                cap.reasoning.push_str(text);
                chunks.push(reasoning_chunk(text));
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let wire_index = u64_field(call, "index").unwrap_or(0);
                    let id = str_field(call, "id");
                    let function = call.get("function").cloned().unwrap_or(Value::Null);
                    let name = str_field(&function, "name");
                    let arguments = str_field(&function, "arguments");
                    let slot = if !id.is_empty() {
                        let tool_index = self.state.tools.len() as u64;
                        self.state
                            .by_block
                            .insert(wire_index, self.state.tools.len());
                        self.state.tools.push(ToolState {
                            index: tool_index,
                            id: id.clone(),
                            name: name.clone(),
                            raw: String::new(),
                            signature: None,
                            done: false,
                        });
                        self.sync_tools(cap);
                        chunks.push(tool_start(tool_index, &id, &name));
                        self.state.tools.len() - 1
                    } else {
                        self.state
                            .by_block
                            .get(&wire_index)
                            .copied()
                            .unwrap_or_else(|| self.state.tools.len().saturating_sub(1))
                    };
                    if arguments.is_empty() {
                        continue;
                    }
                    let index = {
                        let Some(tool) = self.state.tools.get_mut(slot) else {
                            continue;
                        };
                        tool.raw.push_str(&arguments);
                        tool.index
                    };
                    self.sync_tools(cap);
                    chunks.push(tool_delta(index, &arguments));
                }
            }
        }
        if self.state.open_done {
            self.close_open_tools(chunks, cap);
            self.state.open_done = false;
        }
    }

    fn on_ollama(&mut self, line: &str, chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if value.get("done").and_then(Value::as_bool).unwrap_or(false) {
            if let Some(prompt) = u64_field(&value, "prompt_eval_count") {
                cap.prompt_tokens = prompt;
            }
            if let Some(completion) = u64_field(&value, "eval_count") {
                cap.completion_tokens = completion;
            }
        }
        let Some(message) = value.get("message") else {
            return;
        };
        if let Some(text) = message.get("thinking").and_then(Value::as_str)
            && !text.is_empty()
        {
            cap.reasoning.push_str(text);
            chunks.push(reasoning_chunk(text));
        }
        if let Some(text) = message.get("content").and_then(Value::as_str)
            && !text.is_empty()
        {
            cap.text.push_str(text);
            cap.saw_text = true;
            chunks.push(text_chunk(text));
        }
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let function = call.get("function").cloned().unwrap_or(Value::Null);
                let name = str_field(&function, "name");
                let args = function.get("arguments").cloned().unwrap_or(Value::Null);
                let raw = if let Some(text) = args.as_str() {
                    canonical_json(text)
                } else {
                    canonical_from_value(&args).0
                };
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| self.ids.next_id());
                let tool_index = self.state.tools.len() as u64;
                self.state.tools.push(ToolState {
                    index: tool_index,
                    id: id.clone(),
                    name: name.clone(),
                    raw: raw.clone(),
                    signature: None,
                    done: true,
                });
                self.sync_tools(cap);
                chunks.push(tool_start(tool_index, &id, &name));
                chunks.push(tool_delta(tool_index, &raw));
                chunks.push(tool_done(tool_index));
            }
        }
    }

    fn finish_tool(&mut self, slot: usize, chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture) {
        let Some(tool) = self.state.tools.get_mut(slot) else {
            return;
        };
        if tool.done {
            return;
        }
        tool.done = true;
        let index = tool.index;
        self.sync_tools(cap);
        chunks.push(tool_done(index));
    }

    fn close_open_tools(&mut self, chunks: &mut Vec<LlmChunk>, cap: &mut StepCapture) {
        let slots: Vec<usize> = self
            .state
            .tools
            .iter()
            .enumerate()
            .filter(|(_, tool)| !tool.done)
            .map(|(slot, _)| slot)
            .collect();
        for slot in slots {
            self.finish_tool(slot, chunks, cap);
        }
    }

    fn sync_tools(&self, cap: &mut StepCapture) {
        cap.tools = self
            .state
            .tools
            .iter()
            .map(|tool| CapturedTool {
                id: tool.id.clone(),
                name: tool.name.clone(),
                raw_args: tool.raw.clone(),
                thought_signature: tool.signature.clone(),
                done: tool.done,
                index: tool.index,
            })
            .collect();
    }
}
