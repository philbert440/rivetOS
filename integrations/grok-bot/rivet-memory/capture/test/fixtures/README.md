# Grok Bot capture fixtures (synthetic)

Hand-written transcripts, a few lines each. One file per distinct parser
behavior. No production agent ids, host paths, emails, or chat text.

Ids are clearly fake (`00000000-0000-4000-8000-00000000N` or repeating
test UUIDs). People are Pat / example.com. Home and roster paths stay under
`/tmp`. Personas are Alpha / Beta / Gamma — never house names.

## Format (a): on-disk agent-transcripts jsonl

- `ondisk-basic.jsonl` — user, assistant, tool call + result
- `ondisk-hidden.jsonl` — first-run / profile / routine / skipped /
  background / `[agent]` system events
- `ondisk-wrappers.jsonl` — wrapper strip + `[Image]` stub + unmarked reaction
- `ondisk-unstamped.jsonl` — no `<timestamp>` tags; `send_message` epoch

Oversized cap payloads are generated in the test (`'x'.repeat(n)`), not
committed.

## Format (b): ReadTranscript page text

Header: `Transcript of agent "NAME" (UUID), positions A–B of N:` (en dash),
`Transcript of this conversation, positions A–B of N:`, or the generic
`Transcript of <target>, positions A–B of N:` used by page-dump backfill.
Footer (`Older messages remain…`) is absent when A=0. Tool results use `result`.
Page-dump files are named `<bot-slug>-<before>.txt` (tests generate these
under `/tmp`; slugs come from fixture `profile.json` names).

- `page-named.txt` — named agent + footer
- `page-this-conversation.txt` — header variant + send_message epoch
- `page-start.txt` — A=0, no footer

## Format (c): store.db transcript_entries

Tests build a sqlite file with synthetic content via `writeRedactedStoreFixture`.

## Format (d): voice-calls/*.json

`voice-calls/call-redacted.json` is synthetic content on the real call shape.
