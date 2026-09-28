# Grok Bot capture fixtures (redacted)

Real Grok Bot transcripts, trimmed and redacted. Structure is untouched.

Redactions: emails other than rivetphilbot@gmail.com → redacted@example.com;
IPv4 → 192.0.2.1 (TEST-NET); host:port → REDACTED_HOST:PORT; container ids →
CT-REDACTED; home dirs → /home/user.

## Format (a): on-disk agent-transcripts jsonl

- `ondisk-rivet-first-run-0-240.jsonl`
- `ondisk-rivet-agent-msgs-1880-1920.jsonl`
- `ondisk-bob-0-16.jsonl`
- `ondisk-unstamped-hidden.jsonl` — real on-disk shape for a bot with no
  `<timestamp>` tags: hidden first-run + routine, `[tNu]` user turn, and a
  `send_message` `result.success.timestamp` epoch. Synthetic content only.

## Format (b): ReadTranscript page text

Header: `Transcript of agent "NAME" (UUID), positions A–B of N:` (en dash),
or `Transcript of this conversation, positions A–B of N:`. Footer
(`Older messages remain…`) is absent when A=0. Tool results use `result`.

- `page-rivet-2395-2445.txt`
- `page-rivet-4730-4738.txt`
- `page-rivet-this-conversation-3040-3056.txt`
- `page-maggie-0-20.txt`
- `page-maggie-175-195.txt`
- `page-bob-4110-4148.txt`

`synthetic-wrappers.jsonl` covers wrapper types that do not appear in the
trimmed real windows.

## Format (c): store.db transcript_entries

Real schema from 13 live stores (read-only):
`transcript_entries(seq INTEGER PRIMARY KEY, id TEXT, entry TEXT)` plus
unused `kv` / `blobs` / `automation_completion_inbox`. `seq` is 1..N.
`entry` is JSON with `kind` (`message`, `send-message`, `event`,
`spend-initiation`, `user-attachment`, `feedback`) and integer
`timestampMs`. Tests build a redacted sqlite file with synthetic content
via `writeRedactedStoreFixture`. Positions are `seq`, ingested as
`-v3-store`.

## Format (d): voice-calls/*.json

Real shape: top-level `callId` + `startedAtMs`; turns have `speaker`,
`atMs`, optional `toolCalls` / `nudges`. `voice-calls/call-redacted.json`
is synthetic content on that shape. Positions are turn indices, ingested
as `-v3-voice-<stem>`.
