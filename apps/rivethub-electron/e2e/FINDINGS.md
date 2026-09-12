# ct111 desktop audit — 2026-09-11

Historical baseline on main. See [FIXES.md](FIXES.md) for the subsequent fixes
and verification. The original HTML report and JSON results are preserved under
`artifacts/main-audit-report/` and `artifacts/main-audit-results.json`.

The application is **not fully passing**: **41 of 46 tests passed; 5 failed**
(5.4 minutes, no retries or skips). The full run results are recorded in
`artifacts/results.json` and `playwright-report/index.html`. Known failures remain
normal failing assertions, so automation will continue to flag them.

## Build and environment

- Host: `rivet@ct111` (`rivet-omarchy`), real Hyprland desktop.
- Desktop and gateway source: main `abd8572f20af438e4d5df1205b43ed3758a36da1`.
  Confirmed against a fresh `origin/main` fetch immediately before the final run.
- Installed desktop: `/home/rivet/.local/bin/RivetHub`, version **0.5.22**,
  Electron **43.4.0**. Web stamp: `dist abd8572f`, built `2026-09-11 23:34Z`.
- Installed AppImage SHA-256:
  `8f8e8fe04b566b4b8e057365ae4c8bf90b90a712e40d29dbcda92f161be768dd`.
- Gateway checkout: `/home/rivet/.rivetos/src`; user service `rivetos` is active.
  Native `node-pty` was rebuilt and the gateway restarted; terminal creation works.
- Original 0.5.21 binary retained at
  `/home/rivet/rivethub-e2e-run/RivetHub-0.5.21.backup` on ct111.
- Full monorepo build passed (48 projects); desktop unit tests **182 passed**;
  web unit tests **813 passed**. Logs are in `artifacts/`.
- Native StatusNotifierItem registration/property test passed on ct111 with
  Electron 43.4.0. This used the preceding main build; the native shell code and
  Electron version were unchanged in the final build. It is not an OS tray-click test.

No application source fixes are included in this test branch. The installed app
and gateway use main; this branch adds the independent E2E harness and findings.

## Confirmed application defects

### RH-E2E-001 — terminal image addon fails under the packaged desktop CSP

**Impact:** Opening a real terminal produces an uncaught WebAssembly error.
Keyboard input works, but the sixel/image decoder cannot initialize.

**Reproduce:** Connect to ct111, start a session, switch to Terminal. Observe
`WebAssembly.instantiate()` rejected by the `script-src 'self'` policy.

**Evidence/test:** `chat.spec.mjs`, real terminal test; its `renderer-errors.json`,
screenshot and trace. This is a packaged desktop failure, not a mocked browser test.

**Cause supported by source:**
`apps/rivethub-electron/src/main/serve-dist.ts:72` permits only `'self'` scripts;
`apps/rivethub-web/src/components/xterm-attach.tsx:417` loads ImageAddon with
`sixelSupport: true`, which requires WebAssembly compilation.

**Suggested fix:** Permit the narrowly scoped `'wasm-unsafe-eval'` capability if
required by the decoder, and handle addon initialization failure gracefully.
Do not loosen the policy to unrestricted `'unsafe-eval'`.

### RH-E2E-002 — Memory cannot discover a working standalone local backend

**Impact:** A connected local node with functioning memory APIs shows the
“Point RivetHub at datahub” setup state instead of Search/Browse/Stats.

**Reproduce:** Use ct111 as the sole connection with no explicit Memory/datahub
override. Open Memory. `/api/memory/stats` succeeds through the same native mTLS
bridge, but the page does not expose local search.

**Evidence/test:** `memory.spec.mjs`, default local discovery test. Explicitly
setting the Memory gateway to `https://localhost:5174` makes Search, Browse,
Stats and Wiki tests pass. This is also a workaround.

**Cause supported by source:** `apps/rivethub-web/src/lib/wiki-client.ts:25`
resolves an explicit override or a mesh entry named datahub; it does not consider
the active standalone gateway's memory capability. This conflicts with the local
mode described in `docs/LOCAL-MODE.md`.

**Suggested fix:** Discover memory on the active local gateway when no explicit
override or designated datahub exists; preserve explicit remote choices.

### RH-E2E-003 — malformed task links return raw database errors

**Impact:** Opening an invalid task link displays an internal UUID/database error
and a loading state instead of a recoverable invalid/not-found message.

**Reproduce:** Open `app://bundle/tasks/rivethub-e2e-not-found`.
`GET /api/tasks/rivethub-e2e-not-found` returns HTTP 500 with
`invalid input syntax for type uuid: "rivethub-e2e-not-found"`.

**Evidence/test:** `workflows-tasks.spec.mjs`, missing task test; requests and DOM
snapshot in the failure trace.

**Cause supported by source:** `packages/core/src/domain/task/task-api.ts:249`
passes the unvalidated path ID to `store.get`; its catch returns the exception
message with status 500. The desktop displays that response.

**Suggested fix:** Validate IDs, return a controlled 400 for malformed IDs and
404 for missing valid IDs, and render a friendly error without retrying a
deterministic invalid request. Adjust the regression assertion to accept the
chosen friendly invalid-ID wording as part of that fix.

## Execution blockers requiring further diagnosis

### RH-E2E-004 — live chat accepts input but does not deliver a reply

The prompt is accepted (HTTP 202 through terminal injection), but no assistant
reply arrives within 90 seconds. The terminal shows Claude Code's first-run
theme/setup screen. Provider onboarding on ct111 must be completed before live
chat can be certified. The terminal CSP error also occurs during this path.
This evidence does not establish that a configured provider would fail.

Regression: `chat.spec.mjs`, live chat response and reload test. It deliberately
fails rather than treating a successful POST as a successful conversation.

### RH-E2E-005 — a simple task does not finish within 90 seconds

A real task on the default local agent is created and its detail page opens,
but its status remains running past the deadline. The test asks for a fixed
short reply without tools, then kills only its own task in cleanup.
Default provider execution needs investigation; this may share the chat setup
blocker, but that causal link is not proven.

Regression: `workflows-tasks.spec.mjs`, task completion test. Creation and a
running status alone do not count as success.

## What is covered and what remains

The suite covers every main navigation area and important CRUD/persistence flows,
including an actual provider-independent workflow that pauses for human approval
and finishes. It runs against a separate temporary desktop profile and the real
gateway. It removes its own files, agent preset, workflow definition and PTYs;
marked task/chat/workflow audit history remains.

After the full run, cleanup was hardened to track terminal creation in secondary
windows and avoid reloading terminal routes after deleting a test PTY. The three
affected terminal/chat/new-window cases were rerun separately; their traces are
under `artifacts/cleanup-test-results`. The full HTML/JSON report was preserved.
`artifacts/full-run-desktop.log` holds the full run's Electron log.

The full coverage table, commands and remaining manual cases are in [README.md](README.md).
Provider-specific streaming/approvals, enrollment/revocation, multi-node failover,
microphone/speaker behavior, OS notification/tray interactions, crash recovery,
and full self-update installation/rollback are not certified by this run.
The updater check tests the visible response from its feed, not installation.
No finite suite establishes that all bugs have been found.

Open the local HTML report for per-test screenshots and traces. Artifacts can
contain private session text and are intentionally ignored by Git.
