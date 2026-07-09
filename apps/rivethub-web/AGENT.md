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
Header ↻ button → confirm → hard-replace transcript from
`GET /api/terminal/harness-sessions/:id/transcript` (claude jsonl / grok chat_history / hermes sqlite).
Falls back to memory+ring if the store is empty. Store method: `useChat.replace`.

### Track 1 — Rich chat — **shipped** (PR #329)

| Area | State |
|------|--------|
| Transcript | react-markdown + GFM; fenced code copy; assistant full-width + nerd line |
| Live turn | multi-entry tool stack + reasoningText + human titles |
| Bridge tools | optional summarized `args` on tool.start; key-name + value-pattern redact |
| Ask chips | stick through `done` until live clear / user pick (headless ask path) |
| Tests | pure unit tests under `src/lib/*.test.ts` |

Residual: Hermes/claude-cli adapters may still omit tool args; chips degrade cleanly.

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

- `src/pages/chat.tsx` — seamless session, terminal/den modes
- `src/components/transcript.tsx`, `composer.tsx`, `suggestion-chips.tsx`
- `src/lib/fold-stream.ts`, `tool-titles.ts`, `ask-user.ts`, `switch-mode.ts`, `gateway-url.ts`
- `src/stores/chat.ts` — WS fold, LiveTurn
- `src/stores/connection.ts`, `components/node-switcher.tsx`, `pickers/node-picker.tsx`
- Core bridge: `packages/core/src/domain/gateway-channel.ts` (`bridgeAgentEvent`)

## Gotchas

- Tauri origin is not http(s) — desktop starts unconfigured until a node is set.
- Seamless chat uses harness inject, not only `postMessage` chat-loop.
- Headless CLI ask-tools don’t block; chips = next user turn (Android pattern).
- CI secrets scan blocks real lab `10.4.x` IPs in tests — use `192.168.1.x`.
- Tool `args` on sessions WS: `summarizeBridgeArgs` / den-hook `summarizeToolInput` run every string through value-pattern `redact()` (Bearer/sk-/AKIA/gh_/JWT + key=value) then length-cap — not just secret-named keys.
- `isValidGatewayUrl` is origin-only (no userinfo/path/query/hash) to block poisoned roster open-nav.
