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

Keystroke translation (`adapter.answerKeys`) is lane A2. Until then the driver
composes a text answer and PTY-injects it with submit.
