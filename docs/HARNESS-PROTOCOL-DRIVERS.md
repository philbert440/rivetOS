# Protocol drivers for Claude Code, Grok Build and OpenCode

Status: **ACP drivers for Grok Build and OpenCode implemented behind
`RIVETOS_ACP_HARNESSES`; Claude Code driver still a proposal.** Written
2026-10-09 against Claude Code 2.1.293, Grok Build 1.0.44 and OpenCode
1.18.35. Items marked _unverified_ need a spike before anyone builds on them.

## Context

Chat drives every harness except new Codex sessions by pasting into its TUI
(`PtyHarnessDriver`). Den reads the screen to decide whether a paste is safe
(dialogs, unsent drafts, dim suggestions, idle state), presses Enter, and
infers delivery from hook events and transcript files. The web pump adds
timing policy on top: a 6 s inject latch, `turn_in_flight` backoff and a
30 s delivery window that must track den's own deadlines.

That works with any TUI, and chat and terminal share one live session. The
cost is that every send is inferred from a screen the harness may redraw in
its next release. `blocking-dialog.ts`, `composer-input.ts`,
`permission-prompt.ts`, `ask-picker.ts` and `prompt-keys.ts` took 11 commits
in September 2026 alone; #1153 fixed three misreads of one input box.

Codex already shows the alternative (`docs/CODEX-APP-SERVER.md`). New
sessions go through `codex app-server`, approvals and questions arrive as
typed requests, and a terminal joins the same session as a second client
(`codex --remote <ws> resume <thread>`, `CodexProtocolDriver.terminalArgv`).
Existing TUI sessions stay on the PTY driver.

This document applies that pattern to the three other harnesses people
chat with most.

## What each harness offers

|                                | Claude Code 2.1.293                                                                                | Grok Build 1.0.44                                                                                                                           | OpenCode 1.18.35                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Headless protocol              | `--print --input-format stream-json --output-format stream-json`; Agent SDK wraps it               | ACP over stdio (`grok agent stdio`); `grok -p --output-format streaming-json` emits ACP session updates                                     | HTTP + SSE (`opencode serve`, OpenAPI at `/doc`); also `opencode acp`        |
| Pin a new session id           | `--session-id <uuid>` / SDK `sessionId`                                                            | `--session-id` (UUID)                                                                                                                       | No — `POST /session` returns a `ses_…` id                                    |
| Approvals                      | `canUseTool` callback (`--permission-prompts host`)                                                | ACP `session/request_permission` _(Grok auto-allowed every command tried so far; unverified)_                                               | Permission event on SSE, reply `POST /session/:id/permissions/:permissionID` |
| Questions                      | `AskUserQuestion` arrives through `canUseTool`                                                     | _unverified_                                                                                                                                | Question event, reply `POST /question/:requestID/reply` _(third-party docs)_ |
| Interrupt                      | `Query.interrupt()`                                                                                | ACP `session/cancel`                                                                                                                        | `POST /session/:id/abort`                                                    |
| Terminal and chat live at once | **No** local multi-client mode. `--remote-control` relays through claude.ai and is not a local API | **Possibly**: TUI and IDE clients auto-spawn a shared `grok agent leader`; headless clients register with it _(unverified for one session)_ | **Yes**: `opencode attach <url>` runs the TUI as a client of the server      |

Verified locally from `--help`. Protocol details come from the Agent SDK docs,
the ACP spec and third-party OpenCode notes; check them against
`/doc` and a live session before relying on them.

## ACP across harnesses

ACP (Agent Client Protocol) is the one protocol several harnesses already
speak natively, so standardize on it where it exists. A handshake
(`initialize` + `session/new`) against every installed CLI on 2026-10-09:

| Agent              | Command            | Handshake                     | Session capabilities                                                                  |
| ------------------ | ------------------ | ----------------------------- | ------------------------------------------------------------------------------------- |
| Grok Build 1.0.44  | `grok agent stdio` | ✅, session created           | load, list, resume, close; model + reasoning effort as config options; no image input |
| OpenCode 1.18.35   | `opencode acp`     | ✅, session created           | load, list, resume, fork, close; model + mode as config options; image input          |
| Gemini CLI 0.63.0  | `gemini --acp`     | ✅ (no API key on that node)  | load; image + audio input                                                             |
| Hermes 0.19.0      | `hermes acp`       | ✅ (no provider on that node) | load, list, resume, fork; image input                                                 |
| Copilot CLI 1.0.95 | `copilot --acp`    | ✅ (account not entitled)     | load, list, close                                                                     |

Claude Code, Codex, Cursor and pi have no native ACP. Codex keeps its
app-server driver; Claude Code keeps the SDK design below rather than a
third-party ACP adapter.

Both Grok and OpenCode honor a per-session `cwd` in `session/new`, so one
agent process serves every project. `session/new` returns the harness's own
native id (Grok's UUIDv7, OpenCode's `ses_…`) and the session lands in the
same store the TUI uses, so transcripts, the session list and memory capture
need no binding file.

## Decision

Add one protocol driver per harness, following `CodexProtocolDriver`:

- New sessions created from chat use the protocol. Sessions started in a
  terminal, and nodes without the opt-in, keep the PTY driver unchanged.
- Where the harness lets a terminal join as a second client (OpenCode,
  possibly Grok), use that, as Codex does.
- Where it does not (Claude Code), one side owns the session at a time and
  den hands it over. The transcript file is shared, so nothing is lost.
- `SessionSummary.transport: 'protocol'` already exists; the drivers set it
  and the hub shows protocol-owned controls exactly as for Codex.

## Claude Code protocol driver

### Transport

Use `@anthropic-ai/claude-agent-sdk` from den-server with
`pathToClaudeCodeExecutable` pointed at the node's installed `claude`, so the
SDK and the TUI run the same Claude Code version and read the same settings,
hooks, plugins and MCP servers (`settingSources: ['user', 'project', 'local']`,
`systemPrompt: { type: 'preset', preset: 'claude_code' }`). Each chat-owned
session is one `query()` in streaming-input mode: `prompt` is an
`AsyncIterable<SDKUserMessage>` den pushes into, which is what makes
`interrupt()`, `setModel()` and `setPermissionMode()` available.

The raw `stream-json` CLI mode would work too, but the SDK already handles the
control protocol (permission requests, interrupt, init) and its types; den
would otherwise reimplement it.

### Identity

Unchanged from `claude-driver.ts`. Den mints the UUID, passes it as
`sessionId` on first start and `resume` afterwards, and the canonical id stays
`claude-code:<uuid>`. Because the SDK writes the same
`~/.claude/projects/…/<uuid>.jsonl` the TUI does, `readClaudeTranscript`,
memory capture and the drawer need no change, and no bindings file is needed.

### Ownership and handoff

Claude Code has no local server a TUI can join, so a session has exactly one
owner:

| State      | Process       | Chat send                                 | Terminal open                                                                                                                  |
| ---------- | ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `idle`     | none          | start `query({ resume })`, becomes `chat` | spawn `claude --resume <uuid>` in the PTY, becomes `terminal`                                                                  |
| `chat`     | SDK `query()` | push to the input stream                  | if a turn is running: refuse with "busy — interrupt or wait"; else `close()` the query, then spawn the TUI, becomes `terminal` |
| `terminal` | TUI in PTY    | **fall back to today's PTY inject path**  | already open                                                                                                                   |

The fallback in `terminal` state matters: a protocol session never behaves
worse than today, it just loses the protocol benefits while a human has the
terminal open. When the terminal is closed (pane exits), the state returns to
`idle` and the next chat send goes back through the SDK.

Never run both processes on one session id at once; both would append to the
same JSONL. Den holds the ownership lock per session id, the same way the term
manager already refuses a second spawn.

### Contract mapping

| Contract          | Protocol path                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startSession`    | `query({ prompt: stream, options: { sessionId, cwd, … } })`; resolve on the `system`/`init` message                                                                                                                                                                                                                 |
| `resumeSession`   | `query({ options: { resume: uuid } })` lazily on the next send                                                                                                                                                                                                                                                      |
| `sendUserTurn`    | push `{ type: 'user', message, parent_tool_use_id: null, uuid, origin: { kind: 'human' } }`. Delivered = the echoed user message with that `uuid` (no delivery window guess). Still reject `turn_in_flight` while a turn runs: the v1 contract forbids silent queuing                                               |
| `interrupt`       | `query.interrupt()`                                                                                                                                                                                                                                                                                                 |
| `resolveApproval` | resolve the pending `canUseTool` promise: `allow` → `{ behavior: 'allow', updatedInput: input }`; `allow-session` → also echo the `localSettings` entry from `suggestions` in `updatedPermissions` (skip it when `suppressAlwaysAllowRule` is set); `deny` → `{ behavior: 'deny', message }`                        |
| Questions         | `canUseTool('AskUserQuestion', input)` → `prompt` event (`kind: 'ask-user'`, questions/options/multiSelect map one-to-one); answer → `allow` with `updatedInput: { questions, answers }` keyed by question text                                                                                                     |
| `subscribe`       | map `SDKMessage`: `stream_event` → text/thinking deltas (`includePartialMessages: true`); `assistant` `tool_use` / `user` `tool_result` → tool events paired by `toolCallId`; `result` → turn complete, usage, cost; `system` `compact_boundary` → context reset marker; `permission_denied` → a denied-tool notice |
| `transcript`      | unchanged `readClaudeTranscript`                                                                                                                                                                                                                                                                                    |

Capabilities: `interrupt`, `approvals`, `liveStream`, `turnOptions` (model via
`setModel`, effort via the turn options the SDK accepts — _verify_),
`imageAttachments` (image content blocks in the user message).

### What this deletes for chat-owned sessions

The draft check, dialog detection, dim-suggestion handling, keystroke
translation for permission and question prompts, the 9-option picker limit,
and the web pump's latch and delivery window. The PTY driver keeps all of it
for terminal-owned sessions.

### Risks and open questions

- **Den restart kills chat-owned turns.** The SDK's CLI process is den's
  child. A turn in flight when den restarts is lost; the transcript still has
  everything before it, and the next send resumes. Codex avoids this with a
  separate app-server service. Start in-process; move to a small per-user
  host process if restarts mid-turn turn out to matter.
- **Waiting for approval across a restart.** The `canUseTool` promise can stay
  pending indefinitely, but not across a den restart. The SDK docs suggest a
  `PreToolUse` hook returning `defer` for long waits so the process can exit
  and resume later; worth evaluating for phone approvals.
- **Hooks.** Den's Claude hooks keep firing under the SDK (same settings), so
  events may arrive twice — once from the hook tap, once from the SDK stream.
  The protocol driver must treat the SDK stream as the source for its own
  sessions and drop hook events for them.
- **Slash commands and `@path`.** Typed `/commands` and `@file` references
  behave as in the TUI unless `client_composed: true` is set. Decide per
  message; default to TUI-like behavior.
- **Terminal detection.** Den must know when the TUI pane exits to return a
  session to `idle`. The term manager already tracks pane death; confirm a
  closed RivetHub terminal view kills or detaches the pane as expected.
- **Billing and auth.** The SDK uses the same Claude Code login as the TUI
  when run with the node's `claude` binary and user settings. _Verify_ that
  subscription auth carries over rather than requiring an API key.

## Grok Build and OpenCode over ACP (implemented)

`acp-rpc.ts` (JSON-RPC over the agent's stdio), `acp-session-host.ts` (load,
prompt, cancel, permissions, update mapping) and `acp-drivers.ts`
(`GrokAcpDriver`, `OpencodeAcpDriver`, subclasses of the PTY drivers).
Enable with `RIVETOS_ACP_HARNESSES=grok,opencode`; single-owner nodes only,
because the agent runs as the den user.

- **Ownership.** No live TUI pane for the session → the turn goes over ACP.
  A pane open → the PTY path exactly as before, and the agent's copy is
  marked stale (`session/close` + `session/resume` before its next turn). The
  terminal spawn route answers 409 `chat_turn_in_flight` while an ACP turn
  runs. Sessions started in a terminal are driven over ACP once their pane is
  gone.
- **Process.** One agent per harness, started on first use. An exit mid-turn
  ends that turn with a retryable error and is never replayed; the next send
  starts a new agent and resumes the session.
- **Resume.** `session/resume` when advertised (no replay), else
  `session/load` with its replayed updates swallowed.
- **Events.** `agent_message_chunk` → `assistant-delta`,
  `agent_thought_chunk` → `reasoning-delta`, `tool_call` / `tool_call_update`
  → `tool-use` / `tool-result` (Grok names tools in `_meta`), the
  `session/prompt` result → `turn-complete`. Den hooks keep firing inside the
  agent; with no pane open their events are dropped as duplicates.
- **Approvals.** `session/request_permission` → an approval card;
  `allow_once` / `allow_always` / `reject_once` map to allow / allow-session /
  deny. Cancel answers open requests `cancelled` before `session/cancel`.
- **Model and effort.** Per-turn values go through
  `session/set_config_option` (`model`, `thought_level` categories),
  validated against the options the agent offers.
- **Start.** OpenCode starts every control-plane session over ACP; its TUI
  could never pin one. Grok does too, unless the caller supplies an id, which
  still goes through `--session-id`.

Live smoke (2026-10-09) through the driver classes: new session, a shell
tool call, an approval (OpenCode with `permission.bash: ask`), then a fresh
driver resuming the session with its context intact — on both agents.

Not done yet:

- **Hub, new chats.** A new conversation's first send still spawns the TUI
  (`termSpawn`), which makes it terminal-owned. It should call
  `POST /api/harnesses/:id/sessions` for ACP harnesses instead.
- **A pane that outlives a peek.** Opening the terminal once leaves the pane
  running, so chat stays on the PTY path until it exits.
- **Grok approvals.** Confirm Grok sends `session/request_permission` for a
  command its policy does not auto-allow.
- **Attachments** over ACP (OpenCode advertises image input).
- **OpenCode `serve`** remains the way to get chat and terminal live at once
  (`opencode attach <url> --session <id>`); revisit after ACP settles.

### OpenCode with open models (GLM 5.3, DeepSeek)

The protocol does not care which model runs. This node's
`~/.config/opencode/opencode.json` already routes `z-ai/glm-5.3` and
`deepseek/deepseek-v4.1-flash` through OpenRouter. Over ACP the model is a
session config option (`openrouter/z-ai/glm-5.3`), so chat can switch it per
turn without restarting anything.

What does differ by model:

- **Tool-call reliability.** Open models make more malformed or skipped tool
  calls than Claude. OpenCode handles retries; chat should show tool errors
  plainly rather than hide them.
- **Reasoning.** DeepSeek and GLM return reasoning that OpenCode exposes as
  reasoning parts; map them to the same thinking display Grok uses.
- **Images.** Check the model's input modalities before allowing an image
  attachment, as the Codex driver does.
- **Context windows and cost** vary per model and come from OpenRouter, not
  den's model sheets.

## Rollout

1. **ACP for Grok and OpenCode** (this change), then the hub's new-chat path.
2. **More ACP agents.** Gemini CLI and Hermes need only a launch command and
   their id rules once configured on a node.
3. **Claude Code SDK driver with handoff.** Largest benefit (most chat
   traffic, most screen-reading bugs) but needs a hub indicator for who owns
   the session.

Each step keeps the PTY driver for terminal-started sessions and ships behind
an opt-in until a live smoke test passes: fresh chat session, first turn,
approval, question, interrupt, attach terminal, detach, send again.

## References

- Agent SDK TypeScript reference and user input guide:
  <https://code.claude.com/docs/en/agent-sdk/typescript>,
  <https://code.claude.com/docs/en/agent-sdk/user-input>
- Agent Client Protocol: <https://agentclientprotocol.com>
- Grok Build headless and ACP: <https://docs.x.ai/build/cli/headless-scripting>
- OpenCode server: <https://opencode.ai/docs/server/>
- Codex app-server integration in this repo: `docs/CODEX-APP-SERVER.md`
