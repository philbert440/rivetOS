# rivethub-grokbot

First-class **RivetHub** plugin for **Grok Bot** (and Cursor-compatible install): shared memory, mesh delegation helpers, host-side transcript capture, and stranger onboarding.

Goal: get as close as possible to a full Rivet mesh member **without hacking the Grok Bot application**.

## Install

This kit is not self-contained yet. The helpers resolve
`integrations/shared/rivet-paths.sh` and the sibling
`integrations/grok-bot/rivet-memory` launcher. A marketplace copy of this
directory alone will not find those files. Use a RivetOS checkout, or set
`RIVETOS_ROOT` to a built tree that contains both paths. Self-contained
marketplace install is later work.

1. Add the RivetOS marketplace (`philbert440/rivetOS` — repo `.cursor-plugin/marketplace.json`) in Grok Bot / Cursor.
2. Install **rivethub-grokbot** (or copy this kit next to `rivet-memory` in a checkout).
3. Run the **`rivetos-onboard`** skill. One fork:
   - **A. RivetOS cloud** — today this is still Postgres via the tenant bundle from `rivetos cloud connect` (or a pasted DataHub / PG URL). The launcher does not read `RIVETOS_CLOUD_TOKEN`. Browser OAuth is not in this kit yet.
   - **B. RivetOS local** — Tailscale + one DataHub endpoint (`RIVETOS_DATAHUB_URL`).
4. Prove with **`rivetos-status`**, then `memory_stats`.

Same plugin either way. Mode chooses where memory/mesh traffic goes.

### Plugin settings

Declared so marketplace / Cursor can show a form (`Plugins → Configure`):

| Variable | Path | Purpose |
| --- | --- | --- |
| `RIVETOS_MODE` | both | `cloud` \| `local` |
| `RIVETOS_CLOUD_TOKEN` | A | Secret account credential. Stored in the plugin form / `~/.rivetos/.env` for later cloud HTTP. The memory launcher does not read it yet. |
| `RIVETOS_CLOUD_URL` | A | Optional; default `https://rivetos.cloud` |
| `RIVETOS_DATAHUB_URL` | B | One local DataHub endpoint |
| `RIVETOS_PG_URL` | B | Legacy / only if DataHub is not enough |

When this kit launches MCP (`RIVETOS_PLUGIN_ENV=1`), plugin variables win over `~/.rivetos/.env`. Empty form placeholders and unsubstituted `${VAR}` tokens do not block the env-file fallback. Other harness launchers keep the historical behaviour: the env file wins. Unquoted `$HOME` in the env file still expands.

### How `~/.rivetos/.env` is read

Launchers **parse** `KEY=VALUE` lines (optional `export` prefix, quotes, last-wins). They never `source` or evaluate the file, so `$(…)` and backticks do not run. Unquoted `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR-default}`, and a leading `~` or `~/…` expand. The same `$VAR` / `${VAR}` / `${VAR:-default}` / `${VAR-default}` forms expand inside double quotes, matching bash — `RIVETOS_ROOT="$HOME/rivetos"` becomes `$HOME/rivetos`. A double-quoted `\$` is a literal `$` (what persist writes). Tilde does not expand inside quotes (`"~/x"` stays `~/x`); `a~b` stays literal. Unquoted `#` starts a comment only after whitespace or at line start (`KEY=#x` and `KEY=a#b` keep the hash; `KEY=a #b` is `a`). Double-quoted escapes match bash: only `\\`, `\"`, `\$`, and `` \` `` lose their backslash (`\n`, `\t`, `\p` stay two characters). Any other shell form the parser cannot reproduce (other `${…}` operators, `'a'\''b'`, a trailing-backslash continuation, unescaped `$(…)` / backticks) is kept literal and prints one warning to stderr that names the key, never the value.

### Power-user fallback

Existing nodes keep working with only `~/.rivetos/.env` (`RIVETOS_PG_URL`). You do not need the onboard wizard. Editing `.env` by hand is **not** the primary stranger path.

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
