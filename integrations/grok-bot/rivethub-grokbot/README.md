# rivethub-grokbot

First-class **RivetHub** plugin for **Grok Bot** (and Cursor-compatible install): shared memory, mesh delegation helpers, host-side transcript capture, and stranger onboarding.

Goal: get as close as possible to a full Rivet mesh member **without hacking the Grok Bot application**.

## Install (stranger path)

1. Add the RivetOS marketplace (`philbert440/rivetOS` — repo `.cursor-plugin/marketplace.json`) in Grok Bot / Cursor.
2. Install **rivethub-grokbot**.
3. Run the **`rivetos-onboard`** skill. One fork:
   - **A. RivetOS cloud** — connect a RivetOS / Rivet Cloud account (token via plugin form; browser OAuth is not in this kit yet).
   - **B. RivetOS local** — Tailscale + one DataHub endpoint (`RIVETOS_DATAHUB_URL`).
4. Prove with **`rivetos-status`**, then `memory_stats`.

Same plugin either way. Mode chooses where memory/mesh traffic goes.

### Plugin settings

Declared so marketplace / Cursor can show a form (`Plugins → Configure`):

| Variable | Path | Purpose |
| --- | --- | --- |
| `RIVETOS_MODE` | both | `cloud` \| `local` |
| `RIVETOS_CLOUD_TOKEN` | A | Secret account credential |
| `RIVETOS_CLOUD_URL` | A | Optional; default `https://rivetos.cloud` |
| `RIVETOS_DATAHUB_URL` | B | One local DataHub endpoint |
| `RIVETOS_PG_URL` | B | Legacy / only if DataHub is not enough |

Launcher read order: **plugin variables first**, then `~/.rivetos/.env`. Empty form placeholders do not block the env-file fallback.

### Power-user / house fallback

House nodes keep working with only `~/.rivetos/.env` (`RIVETOS_PG_URL`). You do not need the onboard wizard. Editing `.env` by hand is **not** the primary stranger path.

Never commit secrets. Status and persist scripts never print PG URLs or tokens.

## What’s in the box

| Layer | Provides |
| --- | --- |
| Plugin (in-app) | Memory MCP, recall + onboard/status + mesh-delegate skills, member rules |
| Host companion | Transcript discover/watch/ingest (see `host/` — expansion plan, not this onboarding slice) |
| Hooks (soon) | Turn-end capture when Grok Bot exposes hooks — see `hooks/` |

MCP is the sibling launcher `integrations/grok-bot/rivet-memory/bin/rivet-memory-mcp.sh` (`bin/rivetos-memory-mcp.sh` execs it).

## Non-goals

- Patching or reverse-engineering the Grok Bot app
- Injecting into Grok Bot UI threads from mesh (no public API yet)
- Replacing Claude Code / Grok Build plugins — those stay separate
- Marketplace submit (still gated)
- Building RivetOS cloud itself (Path A is a honest stub until OAuth lands)

## Relation to `rivet-memory-grokbot`

This package is the wider **member kit**. Phase 1 reuses that MCP launcher. We may fold or deprecate the narrower plugin once this ships.

## Plans

- `PLAN-STRANGER-ONBOARDING.md` — approved for implementation (this slice)
- `PLAN-EXPANSION.md` — Capture → Delegation → Den (plan only)

## Version

0.2.0 — stranger onboarding scaffold. Not marketplace-published.
