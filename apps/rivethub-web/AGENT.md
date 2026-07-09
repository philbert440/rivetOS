# AGENT.md — RivetHub (web + desktop)

> Continuity for any Rivet picking this up. Desktop is a thin Tauri shell over this app.

## What this is

**RivetHub** = the node’s face. React (Vite) UI in `rivethub-web`; **Tauri v2** shell in `rivethub-desktop` bundles the same dist (tray, shortcuts, notifications).

- Served by den-server as static root when `static_dir` points here; den viewer nested at `/den/` (`scripts/copy-den.mjs`).
- Talks to RivetOS gateway (`@rivetos/gateway-client`, `@rivetos/types`).
- Seamless modes: chat inject → harness PTY → den events → `bridgeAgentEvent` → sessions WS.

## Status (2026-07-09)

### Sidebar rail order
Top → Chat, Terminal, Den ↗, separator, Files, Tasks. Bottom → Settings, then node switcher.
**Files** = browser for `/rivet-shared` (shared collab mount). Stub page at `/files` until gateway list/read is wired; not personal `~/.rivetos` workspace.

### Chat resync from TUI (Android parity)
**Auto on open:** opening a conversation (and returning Chat←Terminal/Den) pulls
`GET /api/terminal/harness-sessions/:id/transcript` and hard-replaces the chat
transcript from the on-disk store (claude/grok/hermes). Skips while a live turn
is streaming. Ring/memory backfill only if the store is empty.
**Manual:** header ↻ → confirm → same path, forces refetch even mid-live.
Store: `useChat.replace`.

### Track 1 — Rich chat — **shipped** (PR #329)

| Area | State |
|------|--------|
| Transcript | react-markdown + GFM; fenced code copy; assistant full-width + nerd line |
| Live turn | multi-entry tool stack + reasoningText + human titles |
| Bridge tools | optional summarized `args` on tool.start; key-name + value-pattern redact |
| Ask chips | stick through `done` until live clear / user pick (headless ask path) |
| Tests | pure unit tests under `src/lib/*.test.ts` |

Residual: Hermes/claude-cli adapters may still omit tool args; chips degrade cleanly.

### Track 3 — Working send queue + ask card

- **`turn.end` den event (protocol v1 additive):** den-hook emits it at Stop
  (grok's detached `--flush` pass emits it after the late text); the bridge
  flushes the assistant message + emits `done` there. Before this, `done` only
  fired at session.end, so the live bubble never cleared and the queue
  deadlocked after the first streamed reply.
- **Queue pump:** post-inject latch poll (6s) replaces the 400ms settle —
  the next queued turn only auto-injects at a real turn boundary. Stale-turn
  release (120s, no frames, no running tool, content-bearing turns, ONLY when
  something is queued) covers harnesses that never bridge done (Hermes) —
  generous because the bridge is block-granular for claude (long no-tool
  generations are silent).
- **inject** on a queued bubble = interrupt-inject: `/term/inject
  {interrupt:true}` writes Esc (behind the paste/CR serialization watermark —
  never between a prior turn's paste and its CR), waits 400ms for the TUI
  cancel redraw, then pastes. **cancel** recalls the text into the composer
  (ComposerHandle.prepend).
- **Ask card** (`ask-user-card.tsx`) replaces suggestion chips: structured
  `extractAskUserQuestions` (question/header/description/multiSelect), stashed
  in `useChat.ask` when the turn ends so it survives the live clear; cleared on
  user echo / send / dismiss / hard resync. Single-select answers on click;
  multi-select / multi-question collects then sends `Header: label` lines.

### Track 2 — Hub-as-node navigation — **shipped** (PR #330)

- Browser: `performNodeSwitch` → `window.open(origin, '_blank')` new tab (current chat/turn stays put)
- Tauri: still `switchTo` (local shell + API re-point)
- Wired in sidebar `NodeSwitcher` + composer `NodePicker`
- Den embed at Chat | Terminal | Den and `/den/` preserved
- New tab is a **different origin** → that origin’s own `localStorage` roster + `sessionStorage` tokens (empty roster / re-auth is expected, not a bug)

## How to run / build

```sh
# web
npx nx build @rivetos/rivethub-web   # also builds den into dist/den/

# desktop (after web dist)
cd apps/rivethub-desktop && cargo tauri build   # or dev
```

## Key files

- `src/pages/chat.tsx` — seamless session, terminal/den modes, queue pump
- `src/components/transcript.tsx`, `composer.tsx`, `ask-user-card.tsx`
- `src/lib/fold-stream.ts`, `tool-titles.ts`, `ask-user.ts`, `switch-mode.ts`, `gateway-url.ts`
- `src/stores/chat.ts` — WS fold, LiveTurn
- `src/stores/connection.ts`, `components/node-switcher.tsx`, `pickers/node-picker.tsx`
- Core bridge: `packages/core/src/domain/gateway-channel.ts` (`bridgeAgentEvent`)

## Gotchas

- Tauri origin is not http(s) — desktop starts unconfigured until a node is set.
- Seamless chat uses harness inject, not only `postMessage` chat-loop.
- Headless CLI ask-tools don’t block; the ask card's pick = next user turn (Android pattern).
- CI secrets scan blocks real lab `10.4.x` IPs in tests — use `192.168.1.x`.
- Tool `args` on sessions WS: `summarizeBridgeArgs` / den-hook `summarizeToolInput` run every string through value-pattern `redact()` (Bearer/sk-/AKIA/gh_/JWT + key=value) then length-cap — not just secret-named keys.
- `isValidGatewayUrl` is origin-only (no userinfo/path/query/hash) to block poisoned roster open-nav.
