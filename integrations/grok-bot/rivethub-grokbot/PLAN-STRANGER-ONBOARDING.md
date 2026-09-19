# rivethub-grokbot — minimal stranger onboarding

**Status:** approved for implementation (2026-09-19)  
**Date:** 2026-09-19  
**Owner (draft):** rivethub-grokbot maintainers  
**Related:** `rivethub-grokbot` expansion plan (Capture → Delegation → Den). This doc is the **Later** item “per-user datahub onboarding for strangers,” pulled forward as its own plan. Does **not** reorder 1→2→3.

In-tree path: `integrations/grok-bot/rivethub-grokbot/PLAN-STRANGER-ONBOARDING.md`

---

## Goal

A new user installs the plugin from marketplace and hits **one fork**:

| Path | User does | Then |
| --- | --- | --- |
| **A. RivetOS cloud** | Connect RivetOS account (OAuth / signed-in link) | Off and running — no Tailscale, no DataHub URL |
| **B. RivetOS local** | Connect Tailscale account + paste DataHub endpoint | Off and running against their hub |

Same plugin either way. Mode chooses *where* memory/mesh traffic goes, not a different feature set.

---

## Non-goals (this plan)

- Building RivetOS cloud itself (assume account + API exist or land in parallel)
- Full mesh node enrollment / NFS / CA ceremony for strangers
- Reordering Capture → Delegation → Den
- Patching the Grok Bot app
- Baking secrets into the plugin package
- Marketplace submit (still gated on house proofs + Philip yes)

---

## Product shape

### First-run fork (one question)

After marketplace install / first MCP start, surface a single setup choice:

1. **Use RivetOS cloud**  
2. **Use my local RivetOS (Tailscale + DataHub)**

Persist choice as plugin config (see Settings). Re-runnable from a `setup` / `onboard` skill.

### Path A — RivetOS cloud

**User steps**

1. Install plugin from marketplace.  
2. Choose cloud.  
3. Connect RivetOS account (browser OAuth or “open RivetOS → approve Grok Bot”).  
4. Done.

**What the plugin stores**

- `RIVETOS_MODE=cloud`  
- Account token / refresh handle via **host secret store or plugin secret variable** (never in git, never in chat)  
- Cloud API base URL (default shipped; overridable)

**What “off and running” means**

- MCP memory tools talk to cloud memory API (same tool names as today).  
- Capture ingest targets cloud write endpoint when present.  
- No Tailscale required on the Grok Bot computer.

**Open dependency / v1 honesty**

- Cloud must expose: auth, memory read/write (or MCP bridge), and later mesh/delegate if we promise parity. If cloud is thinner at v1, document “memory only” vs “full mesh.”
- **This kit does not ship browser OAuth.** Path A is a skill + plugin variables (`RIVETOS_CLOUD_TOKEN`, optional `RIVETOS_CLOUD_URL`, default `https://rivetos.cloud`) plus today’s `rivetos cloud connect` tenant bundle. Memory sidecar still speaks Postgres.

**Name collision:** boot/CLI already use `RIVETOS_MODE=workspace` for source-checkout plugin discovery. Persist must not clobber `workspace` / `production`. Plugin `cloud` \| `local` is the stranger fork.

### Path B — RivetOS local

**User steps**

1. Install plugin from marketplace.  
2. Choose local.  
3. **Connect Tailscale** — install/login if needed (`tailscale up`), join their tailnet (auth key or interactive). Plugin guides; does not invent keys.  
4. **DataHub endpoint** — paste base URL (or MagicDNS name) for their DataHub / den / PG gateway — whatever the supported “one endpoint” is. Prefer one field, not a pile of URLs.  
5. Optional prove: `memory_stats` / health ping.  
6. Done.

**What the plugin stores**

- `RIVETOS_MODE=local`  
- `RIVETOS_DATAHUB_URL` (or today’s `RIVETOS_PG_URL` if endpoint *is* Postgres — prefer a stable public name `DATAHUB` even if it maps to PG under the hood)  
- Tailscale: not a plugin secret; OS/tailscaled state. Setup skill only checks `tailscale status` and reachability to the endpoint.  
- Embed URL/model only if not implied by DataHub.

**What “off and running” means**

- Tailscale up; DataHub reachable from this computer.  
- MCP launcher loads endpoint from plugin settings / `~/.rivetos/.env`.  
- Capture watcher can ingest to the same store.

**v1 DataHub contract:** a `postgres://` / `postgresql://` URL (MagicDNS host fine). The launcher maps `RIVETOS_DATAHUB_URL` → `RIVETOS_PG_URL`. HTTPS den / MCP-bridge endpoints are stored but not auto-converted.

---

## Plugin settings (minimal)

Today (house): host `~/.rivetos/.env` only. Target: small declared variable set so marketplace/Cursor can show a form.

| Variable | Path | Purpose |
| --- | --- | --- |
| `RIVETOS_MODE` | both | `cloud` \| `local` |
| `RIVETOS_CLOUD_TOKEN` (secret) | A | Account credential after OAuth |
| `RIVETOS_CLOUD_URL` | A | Optional override of default cloud API |
| `RIVETOS_DATAHUB_URL` | B | Local DataHub endpoint |
| `RIVETOS_PG_URL` (secret, legacy) | B | Only if DataHub URL is not enough and PG must be direct |

Launcher behavior:

1. Read plugin variables first.  
2. Fall back to `~/.rivetos/.env` for power users / house nodes.  
3. If mode unset → run onboard skill (fork question), don’t silently assume house layout.

No Tailscale auth key in plugin settings (too easy to leak). Local path uses Tailscale CLI / user login.

---

## UX flow (skills)

1. **`rivetos-onboard`** (first run / “set up RivetOS”)  
   - Widget: Cloud vs Local.  
   - Branches into A or B steps above.  
   - Ends with one prove call (`memory_stats` or cloud health).  
2. **`rivetos-status`** — mode, Tailscale online?, endpoint reachable? (no secret dumps).  
3. Existing memory/mesh skills unchanged once configured.

---

## Mapping to house reality (today)

| Piece | House (Philip) | Stranger cloud | Stranger local |
| --- | --- | --- | --- |
| Plugin install | marketplace (needed) | marketplace | marketplace |
| Network | Tailscale node `grokbot` | none | user’s Tailscale |
| Store | DataHub PG via Tailscale | RivetOS cloud API | user’s DataHub endpoint |
| Config | `~/.rivetos/.env` | plugin secrets | plugin vars + optional `.env` |
| Capture | host watcher | cloud write when online | same watcher → their hub |

House stays Path B–shaped (local), without needing the stranger wizard.

---

## Implementation slices

1. **Spec freeze:** exact DataHub URL shape; cloud auth mechanism; v1 cloud scope (memory-only vs mesh).  
2. **Plugin variables + launcher** read order (vars → `.env`).  
3. **`rivetos-onboard` + `rivetos-status` skills** with the fork widget.  
4. **Path B prove:** Tailscale status + TCP/HTTP to DataHub + `memory_stats`.  
5. **Path A prove:** OAuth + one cloud memory round-trip (needs cloud surface). **Stubbed honestly** in this slice.  
6. **Docs:** README install = marketplace + onboard skill; remove “edit `.env` by hand” as the primary stranger path.  
7. **Still Later:** full mesh CA/NFS node join for strangers; cloud capture when computer off.

---

## Risks

- Cloud path blocks on product not built yet — ship local fork first if cloud auth slips.  
- “One DataHub endpoint” may hide PG vs HTTPS den vs MCP bridge — pick one contract and stick to it.  
- Grok Bot must load marketplace plugins + surface plugin variables (local `plugins/local` still won’t help strangers).  
- Tailscale UX varies (auth key vs browser login); guide both, store neither key in the plugin.

---

## Done when

- Stranger can finish Path A **or** Path B without reading house runbooks.  
- No secrets in repo.  
- House node still works via `.env` fallback.  
- Onboard is re-runnable; status skill shows mode + reachability.
