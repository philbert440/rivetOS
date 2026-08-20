# Grok Build + Kimi Capture Verification

## Summary

This document verifies that both Grok Build (`rivet-grok`) and Kimi (`rivet-kimi`) memory capture systems properly store tool calls, thinking/reasoning, and assistant replies in the RivetOS memory database.

## Current State

As of commit 6ddda179 (May 25, 2026), the Grok Build capture system reads `~/.grok/sessions/<urlencoded-cwd>/<sessionId>/updates.jsonl` directly and captures:

### ✅ Captured Event Types

1. **`user_message_chunk`** → `role=user`
   - Full user prompts with content
   
2. **`agent_message_chunk`** → `role=assistant` 
   - Assistant response text
   - Previously: 0% captured (hook payloads had no response text)
   - Now: 100% captured from updates.jsonl

3. **`agent_thought_chunk`** → `role=assistant` with `[thinking]` prefix
   - Agent reasoning/thinking content
   - Previously: not captured
   - Now: 100% captured

4. **`tool_call` + `tool_call_update` (status=completed)** → `role=tool`
   - **`tool_name`**: Tool name (e.g., "search_tool", "read_file", "run_terminal_command")
   - **`tool_args`**: Full input arguments as JSON (stored in `toolArgs` field, then `tool_args` column)
   - **`tool_result`**: Structured output with:
     - For Bash: `output_for_prompt` + exit_code/timed_out/truncated flags
     - For GrepSearch: stdout as UTF-8 text
     - For ReadFile: FileContent.content
     - For SearchTool: result_count + content
     - For MCP: `[mcp server/tool]` header + output
     - For ListDir: Content.content
     - For Todo: TodosUpdated.summary_for_prompt
     - Unknown types: JSON with byte arrays decoded to UTF-8
   - Previously: hook payloads contained only `{"status":"completed"}` stub
   - Now: 100% captured with full structured output

5. **`memory_flush_started` / `memory_flush_completed`** → `role=system`
   - Grok's internal memory state transitions

### ❌ Intentionally Skipped (High Volume, Low Recall Value)

1. **`hook_execution`** - Our own hooks firing (meta-event about capture system itself)
2. **`available_commands_update`** - Slash-command catalog dumps (verbose, changes frequently)
3. **`tool_call_update` with status != completed** - In-progress chatter (e.g., `status=in_progress` or `status=null`)

## Database Schema

Tool calls are stored in the `ros_messages` table with:

```sql
INSERT INTO ros_messages
  (conversation_id, agent, channel, role, content, tool_name, tool_args, tool_result, metadata, created_at)
VALUES
  ($conversationId, 'rivet-grok', 'grok-build', 'tool', '[tool] search_tool', 'search_tool', 
   '{"query":"memory_browse","limit":5}', '{"results":[...]}', '{"source":"grok-jsonl",...}', '2026-05-25T14:21:33Z')
```

- **agent**: `rivet-grok` (distinct from `rivet-grokbot`)
- **channel**: `grok-build`
- **role**: `tool` (for tool calls), `assistant` (for replies/thoughts), `user` (for prompts), `system` (for memory flush markers)
- **tool_name**: Populated for role=tool rows only
- **tool_args**: JSON-stringified input arguments
- **tool_result**: Human-readable output (truncated at 16k chars with pointer back to source line in updates.jsonl)

## Test Coverage

The test suite (`integrations/grok/rivet-memory/capture/test/smoke.test.ts`) verifies:

1. **Parser correctness** against a real 76-event fixture:
   - 3 user prompts captured
   - 3 assistant replies captured
   - 8 agent thoughts captured
   - 10 tool calls captured with full toolName/toolArgs/toolResult
   - 2 memory flush markers captured
   - 0 hook_execution events leaked
   - 0 available_commands_update events leaked

2. **Tool result readability**:
   - Bash tools use `output_for_prompt` (not raw byte arrays)
   - MCP tools carry readable `[mcp server/tool]` headers
   - No decimal byte array leaks

3. **Idempotency invariants**:
   - Parser is deterministic across runs
   - Parsing a prefix yields a proper prefix (slice-by-count safety)
   - Ordinals are stable across re-parses

4. **End-to-end hook integration**:
   - Hook fires spool correctly
   - SessionEnd sets finalize=true
   - Stop events trigger ingest

## Verification Steps

### 1. Run Tests

```bash
cd /workspace/integrations/grok/rivet-memory/capture
npm test
```

Expected: All 35+ checks pass.

### 2. Inspect Fixture

```bash
cd /workspace/integrations/grok/rivet-memory/capture/test/fixtures/sample-session
# Count event types
jq -r '.params.update.sessionUpdate' updates.jsonl | sort | uniq -c | sort -rn
```

Expected output:
```
     22 tool_call_update
     17 hook_execution
     11 available_commands_update
     10 tool_call
      8 agent_thought_chunk
      3 user_message_chunk
      3 agent_message_chunk
      1 memory_flush_started
      1 memory_flush_completed
```

### 3. Check Database (Requires RIVETOS_PG_URL)

```bash
# Connect to postgres
psql $RIVETOS_PG_URL

# Count Grok Build messages by role
SELECT role, COUNT(*) as count, 
       COUNT(*) FILTER (WHERE tool_name IS NOT NULL) as with_tool_name
FROM ros_messages
WHERE agent = 'rivet-grok' AND channel = 'grok-build'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY role
ORDER BY count DESC;
```

Expected: `role=tool` rows should have `with_tool_name > 0`.

### 4. Browse Recent Session

```bash
# Using the rivet-memory MCP tool:
memory_browse(agent="rivet-grok", limit=50)
```

Expected: Mix of user/assistant/tool rows with tool rows showing toolName populated.

## Known Issues / Limitations

1. **Historical data**: Sessions captured before May 25, 2026 (commit 6ddda179) will NOT have tool calls, as the old hook-payload-driven capture only stored `{"status":"completed"}` stubs.

2. **Deployment lag**: If the updated capture code hasn't been deployed to production hosts, new sessions will still use the old behavior. Verify deployment with:
   ```bash
   ssh <host>
   cd /path/to/rivetos
   git log --oneline integrations/grok/rivet-memory/capture/src/grok-memory-capture.ts | head -1
   # Should show commit 6ddda179 or later
   ```

3. **Session file permissions**: The capture worker must have read access to `~/.grok/sessions/`. If Grok runs as a different user, ensure file permissions allow the rivetos service to read session files.

## Kimi Capture Fix

### Problem

Kimi traces were incomplete:
- ❌ Thinking/reasoning was missing
- ❌ Assistant replies were missing or incomplete

### Root Cause

Hook payloads (`Stop`, `PostToolUse`) carry no reply text. The old capture only extracted:
- User prompts from `UserPromptSubmit` hooks
- Tool calls from `PostToolUse` hooks
- No assistant text
- No thinking

### Solution

Kimi stores full conversations in `wire.jsonl` files at:
```
~/.kimi-code/sessions/<workspace>/<session_id>/agents/<slot>/wire.jsonl
```

The capture now:
1. Reads `wire.jsonl` files (when available)
2. Parses `context.append_loop_event` → `content.part` events
3. Extracts:
   - `part.type = "text"` → `role=assistant` (assistant reply)
   - `part.type = "think"` → `role=assistant` with `[thinking]` prefix
4. Combines with hook messages (user + tool)

### Event Mapping

| Wire Event | Extracted As |
|-----------|--------------|
| `context.append_loop_event` → `content.part` (type=text) | `role=assistant` with part.text |
| `context.append_loop_event` → `content.part` (type=think) | `role=assistant` with `[thinking] ${part.think}` |
| Hook: `UserPromptSubmit` | `role=user` (unchanged) |
| Hook: `PostToolUse` | `role=tool` (unchanged) |

### Test Coverage

```bash
cd integrations/kimi/rivet-memory/capture
npm test
```

New tests verify:
- ✅ parseWireJsonl extracts thinking with `[thinking]` prefix
- ✅ parseWireJsonl extracts assistant text
- ✅ Both use `role=assistant`
- ✅ Timestamps are monotonically increasing
- ✅ Malformed lines are skipped gracefully
- ✅ Tool calls from hooks continue to work

## Comparison with Claude

| Feature | Claude | Kimi (fixed) | Grok Build |
|---------|--------|--------------|------------|
| Tool name | ✅ | ✅ | ✅ |
| Tool args | ✅ | ✅ | ✅ |
| Tool result | ✅ | ✅ | ✅ |
| Assistant replies | ✅ | ✅ | ✅ |
| Thinking/reasoning | ✅ | ✅ | ✅ |
| Capture source | JSONL transcript | Hook + wire.jsonl | JSONL transcript |

**All three systems are now on par** in terms of completeness.

## Kimi-Specific Verification

### 1. Run Kimi tests

```bash
cd integrations/kimi/rivet-memory/capture
npm test
```

**Expected**: All 85+ checks pass, including new wire.jsonl parser tests.

### 2. Check production data

```bash
psql $RIVETOS_PG_URL -c "
  SELECT role, COUNT(*) as count,
         COUNT(*) FILTER (WHERE content LIKE '[thinking]%') as thinking_count
  FROM ros_messages
  WHERE agent = 'rivet-kimi' AND channel = 'kimi-code'
    AND created_at > NOW() - INTERVAL '7 days'
  GROUP BY role
  ORDER BY count DESC;
"
```

**Expected**: 
- `role=assistant` rows should exist (previously: 0)
- `thinking_count` should be > 0 for assistant rows
- `role=tool` rows should have `tool_name` populated (unchanged)

### 3. Browse recent Kimi session

```bash
# Using the rivet-memory MCP tool:
memory_browse(agent="rivet-kimi", limit=50)
```

**Expected**: Mix of user/assistant/tool rows with:
- Assistant replies visible
- Thinking content with `[thinking]` prefix
- Tool calls with toolName populated

## Action Items

- [ ] Verify deployment to production hosts
- [ ] Confirm hooks are installed and firing
  - Grok: `~/.grok/hooks/`
  - Kimi: `~/.kimi-code/hooks/` or `~/.kimi/hooks/`
- [ ] Check recent database rows for tool_name population (Grok)
- [ ] Check recent database rows for assistant + thinking rows (Kimi)
- [ ] Re-ingest historical sessions if needed (optional)

## References

- Pivot commit: 6ddda179 "feat(grok-rivet-memory): pivot capture from hook payloads to updates.jsonl ingestion"
- Test fixture: `integrations/grok/rivet-memory/capture/test/fixtures/sample-session/`
- Capture implementation: `integrations/grok/rivet-memory/capture/src/grok-memory-capture.ts`
