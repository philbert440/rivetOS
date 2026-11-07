# Source-position relocation

## Why

Philip's goal is one most-complete canonical source conversation, with every distinct verified message kept. Capture ingest is insert-only, so a wrong `metadata.position` stays on the row. This operation relocates source-position metadata on existing rows in that conversation. It does not invent sessions or merge distinct occurrences.

## What it does

`relocateSourcePositions` takes a reviewed plan of message UUIDs. Row UUID is the occurrence key. Content hash and tool-call id are never used to pick a row.

It locks the conversation with the same session advisory lock capture uses. Apply also takes `SHARE ROW EXCLUSIVE` on `ros_messages` so a competing ordinary `INSERT` cannot sneak past the advisory lock. Storage has no unique `(source_id)` or `(position, ordinal)` constraint, and `event_id` is often derived from ordinal, so the operator names exact row UUIDs and the engine recomputes `ordinal` / derived `event_id` (capture-core occurrence hash, or `ingestEventId`). Renaming `source_id` alone is not the repair.

Default mode is a dry-run. Apply writes a before-state backup first and aborts if that file cannot persist. Successful apply is idempotent; mixed already-applied/pending plans are rejected.

## What it refuses

- Mapping by content hash or tool-call id
- Cross-conversation moves, mixed already-applied/pending plans, duplicate targets
- Occupied destinations outside the plan
- Splitting a multi-sub source entry, including across a blocked mapping or occupied sibling
- Plans whose destination positions would invert `created_at` browse order
- Destination timestamps (`timestamp_unproven`). v1 does not repair dates. Timestamps from the old position are not destination proof
- Summary source lists whose ordinals would run backward against destination positions or `created_at`

`memory_browse` orders by `created_at`, not source ordinal. A successful metadata relocation is not a claim that canonical visible order was repaired. Reports always set `datesRepaired: false`. Keeping a message UUID is not proof that a contextual summary still covers the right sequence.

## CLI

```
rivetos memory relocate-source-positions --plan plan.json
rivetos memory relocate-source-positions --plan plan.json --apply --backup before.json
```
