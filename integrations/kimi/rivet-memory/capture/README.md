# Kimi Memory Capture

This directory is a workspace package (`@rivetos/kimi-rivet-memory-capture`) that
writes Kimi Code CLI sessions into the shared RivetOS memory store under
`agent = 'rivet-kimi'`.

## Layout

```
capture/
├── package.json          # @rivetos/kimi-rivet-memory-capture (workspace member)
├── tsconfig.json         # extends ../../../../tsconfig.base.json
├── src/
│   └── kimi-memory-capture.ts
├── test/
│   ├── smoke.test.ts
│   └── fixtures/
│       └── sample-hooks/          # synthetic hook payloads (no live session yet)
│           ├── user-prompt.json
│           ├── post-tool-use.json
│           └── stop.json
└── dist/                 # built by `npm run build` — gitignored
    └── kimi-memory-capture.js
```

> **Workspace placement.** Mirror the grok capture package: add
> `integrations/kimi/rivet-memory/capture` to the root `package.json`
> `workspaces` array so `npm install` / `npm run build` pick it up.

## Build

```bash
npm install        # picks up this workspace, installs pg + @types/pg + tsx
npm run build      # produces dist/kimi-memory-capture.js
```

`bin/kimi-memory-hook.sh` prefers `dist/kimi-memory-capture.js` and falls back to
`npx --yes tsx` against the .ts source if the build is missing.

## Design Goals

- **Never block Kimi**: hook scripts return in single-digit milliseconds.
- **Hook-payload first**: extract user prompts, tool I/O, and any assistant text
  the payload carries. Session-file tailing is optional and only needed if live
  payloads omit content (as Grok's did).
- **Best effort**: failures are logged to `~/.rivetos/kimi-memory-capture.log`
  but never impact the user's CLI session.
- **Idempotent**: content-hash `event_id` — same payload twice →
  `inserted=1 skipped=0` then `inserted=0 skipped=1`.

## Architecture (hook-payload ingestion)

```
Kimi hook fires (Stop / SessionEnd / PreCompact / UserPromptSubmit / …)
  └── bin/kimi-memory-hook.sh
      └── kimi-memory-capture --hook <event>
          └── spools a CaptureOp { kind: 'hook', sessionId, sourceEvent, payload, finalize? }
              └── detached worker (--worker <spoolFile>)
                  └── processOp(op)
                      1. messagesFromHookPayload(event, sessionId, payload)
                      2. contentHashEventId(...) per message
                      3. acquire pg_advisory_xact_lock(hashtext(sessionKey))
                      4. find-or-create ros_conversations (agent=rivet-kimi)
                      5. for each message: skip if metadata.event_id exists, else INSERT
                      6. (finalize) flip ros_conversations.active = false
                      7. COMMIT + log inserted=N skipped=M
```

### Payload field casing

kimi-code docs claim snake_case (`session_id`, `tool_name`, …). Grok's docs
lied and delivered camelCase. The parser accepts **both** via `pickString` /
`pickUnknown` helpers. After a live hook fire, record the actual shape here.

### Content-hash event_id

```
event_id = sha256(sessionId \0 role \0 content \0 toolName \0 toolResult \0 sourceEvent)
```

Dedup is SELECT-then-INSERT on `metadata->>'event_id'`. A future partial unique
index on `(conversation_id, (metadata->>'event_id'))` would allow
`ON CONFLICT DO NOTHING`.

### Optional session-file path

`findSessionDir` / `SESSIONS_ROOT_CANDIDATES` scan:

```
$KIMI_CODE_HOME/sessions
~/.kimi-code/sessions
~/.kimi/sessions
(+ projects/ variants)
```

They return null until the on-disk layout is verified. When a transcript format
is known, add a JSONL (or equivalent) parser and prefer it for full assistant
text — same pattern as Grok's `updates.jsonl` ingest.

## Database Schema

Writes to the standard RivetOS tables:
- `ros_conversations` (with `agent = 'rivet-kimi'`, `channel = 'kimi-code'`)
- `ros_messages` (with `metadata.event_id`, `metadata.event_ts`, `metadata.sourceEvent`)

## Tests

```bash
npm test
# or: npx tsx test/smoke.test.ts
```

Layers:
1. **messagesFromHookPayload** — role/content extraction from fixtures
2. **contentHashEventId** — stability + collision resistance
3. **pickString casing** — snake_case and camelCase
4. **`--hook` spool e2e** — writes CaptureOp without spawning worker
   (`KIMI_CAPTURE_NO_WORKER=1`)

## Future Improvements

- Wire session transcript ingest once path/format is known.
- Partial unique index on `(conversation_id, (metadata->>'event_id'))`.
- Shared capture client library with grok/claude implementations.
- Add workspace entry to root package.json (reviewer step).
