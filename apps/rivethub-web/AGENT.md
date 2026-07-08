# AGENT.md — RivetHub (web + desktop)

> Continuity for any Rivet picking this up. Desktop is a thin Tauri shell over this app.

## What this is

**RivetHub** = the node’s face. React (Vite) UI in `rivethub-web`; **Tauri v2** shell in `rivethub-desktop` bundles the same dist (tray, shortcuts, notifications).

- Served by den-server as static root when `static_dir` points here; den viewer nested at `/den/` (`scripts/copy-den.mjs`).
- Talks to RivetOS gateway (`@rivetos/gateway-client`, `@rivetos/types`).
- Seamless modes: chat inject → harness PTY → den events → `bridgeAgentEvent` → sessions WS.

## Status (2026-07-08)

### Track 1 — Rich chat — **shipped** (PR #329)

| Area | State |
|------|--------|
| Transcript | react-markdown + GFM; fenced code copy; assistant full-width + nerd line |
| Live turn | multi-entry tool stack + reasoningText + human titles |
| Bridge tools | optional summarized `args` on tool.start; key-name + value-pattern redact |
| Ask chips | stick through `done` until live clear / user pick (headless ask path) |
| Tests | pure unit tests under `src/lib/*.test.ts` |

Residual: Hermes/claude-cli adapters may still omit tool args; chips degrade cleanly.

### Track 2 — Hub-as-node (PR #330, stacked)

- Browser: `performNodeSwitch` → `location.assign(origin)` (origin = that node)
- Tauri: still `switchTo` (local shell + API re-point)
- Den embed at `/den/` preserved

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
- `src/lib/fold-stream.ts`, `tool-titles.ts`, `ask-user.ts`
- `src/stores/chat.ts` — WS fold, LiveTurn
- `src/stores/connection.ts`, `components/node-switcher.tsx` — multi-node
- Core bridge: `packages/core/src/domain/gateway-channel.ts` (`bridgeAgentEvent`)

## Gotchas

- Tauri origin is not http(s) — desktop starts unconfigured until a node is set.
- Seamless chat uses harness inject, not only `postMessage` chat-loop.
- Headless CLI ask-tools don’t block; chips = next user turn (Android pattern).
- CI secrets scan blocks real lab `10.4.x` IPs in tests — use `192.168.1.x`.
- Tool `args` on sessions WS: `summarizeBridgeArgs` / den-hook `summarizeToolInput` run every string through value-pattern `redact()` (Bearer/sk-/AKIA/gh_/JWT + key=value) then length-cap — not just secret-named keys.
