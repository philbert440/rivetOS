# Grok Bot capture fixtures (synthetic)

Invented transcripts that keep the real Grok Bot shapes. No production
agent ids, host paths, emails, or chat text.

Ids are clearly fake (`00000000-0000-4000-8000-00000000N` or repeating
test UUIDs). People are Pat / example.com. Home and roster paths stay under
`/tmp`. Personas are Alpha / Beta / Gamma — never house names.

## Format (a): on-disk agent-transcripts jsonl

- `ondisk-alpha-first-run-0-240.jsonl` — hidden first-run / profile / routine /
  skipped / background, wrapper strip, mixed user+hidden, replay at 204/225
- `ondisk-alpha-agent-msgs-1880-1920.jsonl` — `[agent]` system events
- `ondisk-beta-0-16.jsonl` — short on-disk window with tool calls
- `ondisk-unstamped-hidden.jsonl` — no `<timestamp>` tags: hidden first-run +
  routine, `[tNu]` user turn, and a `send_message` `result.success.timestamp`
  epoch

## Format (b): ReadTranscript page text

Header: `Transcript of agent "NAME" (UUID), positions A–B of N:` (en dash),
or `Transcript of this conversation, positions A–B of N:`. Footer
(`Older messages remain…`) is absent when A=0. Tool results use `result`.

- `page-alpha-2395-2445.txt` — named agent + footer + oversized tool result
- `page-alpha-4730-4738.txt`
- `page-alpha-this-conversation-3040-3056.txt` — header variant + send_message epoch
- `page-gamma-0-20.txt` — A=0, no footer
- `page-gamma-175-195.txt`
- `page-beta-4110-4148.txt`

`synthetic-wrappers.jsonl` covers wrapper types that do not appear in the
other windows.

## Format (c): store.db transcript_entries

Real schema: `transcript_entries(seq INTEGER PRIMARY KEY, id TEXT, entry TEXT)`
plus unused `kv` / `blobs` / `automation_completion_inbox`. Tests build a
sqlite file with synthetic content via `writeRedactedStoreFixture`.
Positions are `seq`, ingested as `-v3-store`.

## Format (d): voice-calls/*.json

Real shape: top-level `callId` + `startedAtMs`; turns have `speaker`,
`atMs`, optional `toolCalls` / `nudges`. `voice-calls/call-redacted.json`
is synthetic content on that shape. Positions are turn indices, ingested
as `-v3-voice-<stem>`.
