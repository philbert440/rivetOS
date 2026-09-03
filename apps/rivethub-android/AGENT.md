# AGENT.md — rivethub-android

Live state for whoever picks this up next (any model). Keep short; no session diaries.

## What this is

**RivetHub for Android** (`io.rivethub.app`, Apache-2.0, Kotlin/Compose): the desktop RivetHub app,
phone-shaped — same look/feel, same den backend, same harness-session model, device mTLS only, nothing
runs on the phone. Off-LAN via the stock Tailscale app. The plan of record is
`/rivet-shared/plans/rivethub-android-2026-09-02.md` (v2, reviewed); read it before changing anything.

M3b replaced the Grok-Bot UI. M4 attaches Terminal mode to the session PTY. `MainActivity.App()`
routes Enroll → Hub (Conversations / Agents / Nodes / Settings) → Chat. Old Grok-Bot screens, VMs,
`Bot`/`BotRepository`/`SessionResolver` remain in the tree unreferenced so the integrator can `git rm` them.

## Where this tree came from (slice M1a, 2026-09-03)

`git mv` of `apps/rivet-bots-android` (the Grok-Bot-style client, package `dev.rivetos.bots`) with the
package renamed to `io.rivethub.app`, label "RivetHub", DataStore file "rivethub".

What survives into the real app (plan §2): `data/DeviceIdentity.kt` (p12 vault), `data/HttpFactory.kt`
+ `data/LanNetwork.kt` + `LiveLanSocketFactory` (dual-path networking, `ACCESS_LOCAL_NETWORK`),
`gateway/Gateway.kt` (reconnecting WS), `gateway/TermWs.kt`, `gateway/GatewayClients.kt` (injected
OkHttp split), `gateway/Wire.kt` (gateway twins — not reused by the plane), `gateway/HarnessWire.kt`
+ `gateway/HarnessGateway.kt` (M3a), `plane/` (M3a + M3b reducers), `transport/NodeTransport` +
`DirectTransport` (screens obtain gateways only through this seam), `HermesReasoning.kt`,
`ui/term/AnsiTerminal.kt` + `ui/term/TerminalPane.kt` + the OSC colour-query / OSC 52 filter,
`ui/theme` + `ui/components` (M1.5).

## Slices (plan §6)

M1a rename + M6 CI ✔ → M1b `NodeTransport` seam + android-free `domain/gateway/transport` + nx
`project.json` ✔ → M2a p12 import in Settings ✔ (folded into M3b Settings) → M1.5 design system ✔
(`ui/theme` + `ui/components`, gallery behind Settings-title long-press) → M3a pure-Kotlin plane
layer (tests only) ✔ → M3b Compose conversations + chat ✔ → **M4 terminal mode ✔ (this)** → M5a nodes
filter polish → M5b turn-complete notification → M7 cutover.

## Screens

Hand-rolled `Nav` back stack. Start: Enroll if no identity / blank entry URL / not onboarded, else Hub.

| Screen | File | ViewModel | Notes |
|---|---|---|---|
| Enroll | `ui/screens/EnrollScreen.kt` | none (container) | p12 + entry URL; 401 → cert refused |
| Hub | `ui/screens/HubScreen.kt` | `HubViewModel` (activity-scoped `key=hub`) | BottomRail tabs |
| Conversations | `ui/screens/ConversationsScreen.kt` | HubViewModel | recency list, archive swipe, FAB draft |
| Agents | `ui/screens/AgentsScreen.kt` | HubViewModel | catalog rows; tap / ↺ / + pointer semantics |
| Nodes | `ui/screens/NodesScreen.kt` | HubViewModel | view filter only; never rebinds an open chat |
| Settings | `ui/screens/SettingsScreen.kt` | HubViewModel + container | identity, theme, terminal font; title long-press → gallery |
| Chat | `ui/screens/HarnessChatScreen.kt` | `HarnessChatViewModel` via `ScreenStores` | transcript, ask-user, composer, Chat\|Terminal swipe, VT attach |
| Gallery | `ui/components/ComponentGallery.kt` | none | M1.5 preview |

Prefs keys (DataStore `rivethub`): `entryUrl`, `strictHostnames`, `onboarded`, `themeMode`
(`system`\|`light`\|`dark`), `sessionModes` (sessionId → `chat`\|`terminal`), `archived`,
`titleOverrides`, `agentPointers` (`sessionId\\tnodeBaseUrl`), `terminalFontSp`, `viewNodeId`,
`currentAgentId`. Plus leftover Grok-Bot keys still decoded so a wipe is not required.

Chat VM is keyed `chat:<nodeDenUrl>:<sessionKey>` and torn down when that back-stack entry leaves.
Registry watches live in HubViewModel; SessionAttach lives in the chat VM. WS frames are marshalled
onto `viewModelScope` (Main) before `TranscriptMachine` / `applyRegistryEvent`. Network stays on
`Dispatchers.IO`. Identity `generation()` is sampled at start; a bump drops cached clients.

## Core packages

`domain/`, `gateway/`, `transport/`, and `plane/` stay free of `android.*` / `androidx.*` /
`com.android.*` imports (and fully-qualified `android.` / `androidx.` refs) so an iOS port can
share them behind a later Ktor swap. Enforced by `CorePackagesAreAndroidFreeTest`. Screens talk
to nodes only through `NodeTransport` (`DirectTransport` today; `IngressTransport` is a later
drop-in). Harness HTTP/WS is `AppContainer.harness(denUrl)` (same OkHttp generation as Gateway).
No KMP now.

## Harness plane (M3a + M3b)

Pure Kotlin under `gateway/HarnessWire.kt`, `gateway/HarnessGateway.kt`, and `plane/`. Desktop
semantics copied from `apps/rivethub-web` `harness-*.ts` + `ask-user.ts` + `attachments.ts` +
`outbound-pump.ts` + `agent-session.ts`. `+ new` is a bare UUID draft; never call startSession.
First send on a draft: `termSpawn` joined to the draft id (`rosterCommandFor` + `spawnModelEffort`),
wait for registry `session-created`, `adopt`, then `sendTurn`. Attachments are `[attached: uri]`
lines after `POST /api/uploads` on the session's node. Canonical ids contain `:`; path params are
unpadded base64url (`sessionKeyEnc`). Hermes display/live strip stays `data/HermesReasoning.kt`.

## Terminal mode (M4)

Attach protocol (den-server `term/ws.ts`, rivethub-web `xterm-attach.tsx`):

1. `POST /api/terminal` spawn-or-get joined to the chat's canonical/native session id (same
   session as draft first-send — the PTY is that harness TUI). A draft Terminal tab goes through
   `spawnAndAdopt()` before attach, never a second unsynchronised spawn.
2. WS `/api/terminal/ws?id=` — hello JSON, one binary ring frame, live binary, exit JSON.
3. The server replays the ring unconditionally after hello (`term/ws.ts` attach), including
   `mux:'tmux'`. Reset the local VT on hello / reconnect, then write every binary frame. An empty
   ring writes nothing. Never skip replay.
4. Client sends binary keystrokes and JSON `{type:resize,cols,rows}` / `{type:detach}`.
5. **Never send `{type:kill}`.** Leave, background, and the Detach menu send detach then close.
   The manager TTL owns the PTY; reattach replays.
6. OSC 10/11/12 colour queries are stripped and never answered. OSC 52 writes go to the clipboard
   (flagged sensitive on API 33+); OSC 52 reads (`?`) are refused.
7. "Open in your terminal" copies `ssh <sshUser>@<host> -t tmux -L <socket> attach -t <session>`
   rendered from the server `attach` descriptor. Hidden when `attach` is absent — never guess a
   socket name.

Attach lives in `TermAttachController` (driven by `HarnessChatViewModel`) so Chat↔Terminal swipe
does not drop the socket. Inbound frames share one `Channel` consumer (hello → ring order is
structural). Detach only when leaving the screen (VM cleared) or the app backgrounds (`ON_STOP`);
reattach on return if Terminal was wanted. Identity `generation()` bump drops the attach. Font size
is Settings Small/Medium/Large → 11/13/16 sp; cols/rows use a measured "M" and `fontScale`. Ctrl is
one-shot (long-press locks). Two-finger scroll is local `AnsiScreen` scrollback, pinned to an
absolute line while scrolled back; tmux copy-mode history paging is out of scope. DECCKM (`CSI ?1
h/l`) selects SS3 vs CSI arrows. `{type:detach}` is ahead of `@rivetos/types` and a no-op on today's
server — the close is the detach.

## Build / test / install

- Build host: the fleet's Android build box (JDK 21 + SDK 37 + warm Gradle cache) — host names and
  paths are ops notes in Rivet's memory, not here. `./gradlew :app:assembleDebug :app:testDebugUnitTest`.
  Full-suite test counts only — a `--tests` filter can match nothing and still print green; CI
  (`.github/workflows/android.yml`) enforces a floor of 231 (190 + 41 M4 terminal tests).
- Nx targets in `project.json`: `check` → `:app:testDebugUnitTest`, `apk` → `:app:assembleDebug`,
  `verify` → dependsOn check+apk (command `true`), `lint-android` → `:app:lintDebug`. There are no
  nx `build` / `test` / `lint` targets on purpose — Gradle owns those, and the SDK-less monorepo
  sweeps would run a target named `lint`.
- Emulator smoke (API 36, swiftshader) and wireless-adb install from the adb host: ops notes live in
  Rivet's memory, not here. The emulator does NOT enforce Android 16 Local Network Protection — device
  smoke is mandatory for anything touching networking.
- New app id ⇒ fresh `filesDir`: the phone re-imports its device p12 once on first install.

## Contract facts (verified 2026-09-03, main `0c9abd3f`)

- `POST /api/devices/enroll` is WireGuard pairing only (requires a WG `publicKey`, returns mesh config,
  issues NO cert). v1 enrollment = p12 import; QR-to-cert is a separate den+CA program.
- Desktop `+ new` = bare UUID draft, adopted to `harness:uuid` via the registry stream. Never call
  `startHarnessSession` on new (hermes/kimi/dsh refuse it).
- Attachments = `[attached: <uri>]` lines in turn text after `POST /api/uploads` on the session's node;
  `UserTurn.attachments` is rejected by every PTY driver.
- Two `SessionSummary` types: gateway (`id`, epoch-ms) vs `HarnessSessionSummary` (`sessionId`, ISO).
  Canonical ids contain `:`; harness routes take unpadded base64url of the canonical id.
- `/api/notifications/ws` = escalations/gates; turn-complete arrives on the harness-session WS.
- "Open in your terminal" renders the server's `attach` descriptor; never compose the tmux command.

## Gotchas

- Deferred from M1.5 (recorded here, not only in the fix notes): snackbar/toast host, `Composer.enabled=false` also disables Stop, `SelectOption.group` for grouped selects, 44-dp targets on `FilterChipRow`/select trigger, `RivetSelect` `sheetState.hide()` before dismiss, `lint-android` not yet run in CI.
- `usesCleartextTraffic=true` exists only for the noVNC Desktop tab (a non-goal, plan §1); flip it to
  false when `ui/components/DesktopView.kt` is deleted with the Grok-Bot screens.
- Debug builds are `io.rivethub.app.debug`; release is `io.rivethub.app`. Both are fresh ids on the
  Pixel — import the device p12 once per build type. Note the session ring is keyed by the cert CN
  (`deviceTag()` = SHA-256 of the CN), so two installs sharing one p12 share one gateway session ring;
  give the debug install its own device cert if you need them independent.

- Never cache a `Network` handle into anything long-lived; never freeze `Network.socketFactory` onto a client.
- No private IPs anywhere in this tree (CI secret-scan + private-net rule); placeholders use 192.0.2.x.
- `EncryptedSharedPreferences` is deprecated upstream; keep it until a Keystore-wrapped blob exists.
- Never send `{type:kill}` on terminal leave — detach only.
- Desktop injects a draft's first turn into the PTY (`termInject`). The phone has no inject client;
  M3b spawns, waits for `session-created`, then `sendTurn` on the adopted canonical id.
