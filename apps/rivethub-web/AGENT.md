# AGENT.md — RivetHub (web + desktop)

> Continuity for any Rivet picking this up. Desktop is a thin Tauri shell over this app.

## What this is

**RivetHub** = the node’s face. React (Vite) UI in `rivethub-web`; **Tauri v2** shell in `rivethub-desktop` bundles the same dist (tray, shortcuts, notifications).

- Served by den-server as static root when `static_dir` points here; den viewer nested at `/den/` (`scripts/copy-den.mjs`).
- Talks to RivetOS gateway (`@rivetos/gateway-client`, `@rivetos/types`).
- Seamless modes: chat inject → harness PTY → den events → `bridgeAgentEvent` → sessions WS.

## Agreed product direction (2026-07-08)

Two tracks — **do in order**:

### Track 1 — Rich chat experience (current)

Bring phone-grade chat fidelity onto this Hub (Android is the **spec**, not code to copy):

1. Markdown + code copy in transcript  
2. LiveTurn structure: reasoning text, tool stack (not one activity string)  
3. Human tool titles (port Android maps for Claude + Grok names)  
4. Ask-user suggestion chips (`ask_user` / `AskUserQuestion` / `ask_user_question`) — needs stream/bridge tool args where possible  
5. Composer polish; stop/steer if wire allows  

Wire ceiling: `SessionMessage` is still `{ text }` — soft client-side parts first; durable parts later if needed. Grok fidelity depends on den pack emissions, not only React.

**Do not** block Track 1 on multi-node navigation redesign.

### Track 2 — Hub-as-node (after Track 1)

- Each node’s HTTP `/` = this app (sidebar, chat, tasks, settings).  
- Den = embed in Hub + optional full app at `/den/` — not the homepage.  
- **Browser** node switcher = navigate to peer hub URL (origin = node), not SPA cross-origin API re-point as primary.  
- **Desktop** keeps local UI + API `switchTo` (optional “Open in browser”).  
- Mesh: treat advertised URL as hub face (`hubUrl` / existing `denUrl` product language cleanup).

## Current gaps (chat)

| Area | State |
|------|--------|
| Transcript | Plain `whitespace-pre-wrap` — no markdown |
| Live turn | text + activity string + reasoning bool only |
| Bridge tools | name only; args often missing on seamless path |
| Ask chips | none (Android has them) |
| Node switcher | in-SPA `switchTo` + roster |

## How to run / build

```sh
# web
npx nx build @rivetos/rivethub-web   # also builds den into dist/den/

# desktop (after web dist)
cd apps/rivethub-desktop && cargo tauri build   # or dev
```

## Key files

- `src/pages/chat.tsx` — seamless session, terminal/den modes  
- `src/components/transcript.tsx`, `composer.tsx`  
- `src/stores/chat.ts` — WS fold, LiveTurn  
- `src/stores/connection.ts`, `components/node-switcher.tsx` — multi-node  
- Core bridge: `packages/core/src/domain/gateway-channel.ts` (`bridgeAgentEvent`)

## Open questions

- Desktop switcher: stay API re-point only, or also “Open in browser”?  
- Soft vs hard `SessionMessage.parts` for durable tool/reasoning history  
- Mesh field rename `denUrl` → `hubUrl` timing  

## Gotchas

- Tauri origin is not http(s) — desktop starts unconfigured until a node is set.  
- Seamless chat uses harness inject, not only `postMessage` chat-loop.  
- Headless CLI ask-tools don’t block; chips = next user turn (Android pattern).  
