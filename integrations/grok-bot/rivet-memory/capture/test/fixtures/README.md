# Grok Bot capture fixtures (redacted)

Real Grok Bot transcripts, trimmed and redacted. Structure is untouched.

Redactions: emails other than rivetphilbot@gmail.com → redacted@example.com;
IPv4 → 192.0.2.1 (TEST-NET); host:port → REDACTED_HOST:PORT; container ids →
CT-REDACTED; home dirs → /home/user.

## Format (a): on-disk agent-transcripts jsonl

- `ondisk-rivet-first-run-0-240.jsonl`
- `ondisk-rivet-agent-msgs-1880-1920.jsonl`
- `ondisk-bob-0-16.jsonl`

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

No live `agents/<id>/store.db` dump was available. Tests build a redacted
sqlite file from the published grok-bot-mcp / xopc schema
(`entry_id, session_id, seq, entry_kind, role, payload_json, created_at`)
via `writeRedactedStoreFixture`. Positions are `seq`, ingested as `-v3-store`.

## Format (d): voice-calls/*.json

No live voice-call dump was available. `voice-calls/call-redacted.json` is a
reconstructed fixture (role/text turns). Positions are turn indices,
ingested as `-v3-voice-<stem>`.
