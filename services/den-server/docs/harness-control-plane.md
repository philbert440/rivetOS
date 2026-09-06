# Harness control plane — live chat contract (lane A)

Per-session socket: `WS /api/harness-sessions/ws?session=<enc>`.

## Contract semantics

The transcript file is the source of truth for the in-flight turn on stores
that expose it; hook and herdr events refine status.

### Frames (server → client)

In addition to the existing driver events (`assistant-delta`, `turn-complete`,
herdr `status`, …) the per-session socket carries:

- **`transcript`** — watcher deltas (`rev`, `from`, `total`, `turns`, `command`,
  optional `truncatedBefore`). Context stamp (`contextWindow` / `compactAt` /
  `contextSource`) is present on snapshots (`from === 0`) only.
- **`status`** — `{ status: working|blocked|idle, since, source?, phase?, tool?,
  promptId? }`. `source` is `transcript` | `herdr` | `hooks`. Transcript-derived
  frames use `working`/`idle`; herdr may add `blocked`.
- **`prompt`** — AskUserQuestion from a prompt-class tool on the trailing
  assistant turn (`kind: 'ask-user'`, `questions[]`). A later frame with
  `resolved: { at, answerText? }` closes it when the store records the result.

Hook-free **`turn-complete`** is emitted when the trailing assistant turn
becomes `complete` (store `end_turn` / grok final text line / hermes
`finish_reason=stop`).

### Control message (client → server)

`{ "type": "sync" }` — feature-detected `driver.syncTranscript(sessionId)`,
which calls the singleton transcript watcher `sync` under the canonical id.
Anything else on the socket is ignored (same posture as `/api/sessions/ws`).

### HTTP

`POST /api/harness-sessions/:enc/prompts/:promptId`

```json
{ "answers": [{ "question": 0, "labels": ["API key"], "other": "…" }] }
```

→ **202** `{ ok: true, sessionId, promptId }`
→ **400** malformed body
→ **404** `unknown_prompt` (not pending)
→ **501** driver has no `answerPrompt` (capability_unsupported)

Claude answers with TUI keystrokes (`adapter.answerKeys`, Claude Code 2.1.263).
Adapters without `answerKeys` still compose a text answer and PTY-inject it
with submit.

`POST /api/harness-sessions/:enc/approvals/:reqId`

```json
{ "decision": "allow" | "deny" | "allow-session" }
```

→ **202** `{ ok: true, sessionId, requestId }`
→ **400** malformed decision
→ **404** `unknown_approval` (not pending)
→ **501** `capabilities.approvals` is false (no PTY, mux is not herdr, or the
adapter has no permission keys — hermes / deepseek)

Permission prompts are herdr-`blocked` plus a screen capture
(`HerdrCtl.capture`). The driver emits `approval-request` with parsed
`options`; answering injects `adapter.approvalKeys` (`submit: false`). If the
TUI itself dismisses the dialog, the next herdr `working`/`idle` (or a
transcript frame with no running tool) emits `approval-resolved` with
`decision: "external"`. Under tmux the approvals flag stays false and the
card does not mount.
