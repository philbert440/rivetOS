# AGENT.md — rivethub-android

Live state for whoever picks this up next (any model). Keep short; no session diaries.

## What this is

**RivetHub for Android** (`io.rivethub.app`, Apache-2.0, Kotlin/Compose): the desktop RivetHub app,
phone-shaped — same look/feel, same den backend, same harness-session model, device mTLS only, nothing
runs on the phone. Off-LAN via the stock Tailscale app. The plan of record is
`/rivet-shared/plans/rivethub-android-2026-09-02.md` (v2, reviewed); read it before changing anything.

M3b replaced the Grok-Bot UI. `MainActivity.App()` routes Enroll → Hub (Conversations / Agents / Nodes /
Settings) → Chat. Grok-Bot screens/VMs are gone from the tree (removed in the M3b commit).

## Where this tree came from (slice M1a, 2026-09-03)

`git mv` of `apps/rivet-bots-android` (the Grok-Bot-style client, package `dev.rivetos.bots`) with the
package renamed to `io.rivethub.app`, label "RivetHub", DataStore file "rivethub".

What survives into the real app (plan §2): `data/DeviceIdentity.kt` (p12 vault), `data/HttpFactory.kt`
+ `data/LanNetwork.kt` + `LiveLanSocketFactory` (dual-path networking, `ACCESS_LOCAL_NETWORK`),
`gateway/Gateway.kt` (reconnecting WS), `gateway/TermWs.kt`, `gateway/GatewayClients.kt` (injected
OkHttp split), `gateway/Wire.kt` (gateway twins — not reused by the plane), `gateway/HarnessWire.kt`
+ `gateway/HarnessGateway.kt` (M3a), `plane/` (M3a + M3b reducers), `transport/NodeTransport` +
`DirectTransport` (screens obtain gateways only through this seam), `HermesReasoning.kt`,
`ui/term/AnsiTerminal.kt` + the OSC colour-query filter, `ui/theme` + `ui/components` (M1.5).

## Slices (plan §6)

M1a rename + M6 CI ✔ → M1b `NodeTransport` seam + android-free `gateway/transport` + nx
`project.json` ✔ → M2a p12 import in Settings ✔ (folded into M3b Settings) → M1.5 design system ✔
(`ui/theme` + `ui/components`, gallery behind Settings-title long-press) → M3a pure-Kotlin plane
layer (tests only) ✔ → **M3b Compose conversations + chat ✔ (this)** → M4 terminal mode → M5a nodes
filter polish → M5b turn-complete notification → M7 cutover.

## Screens

Hand-rolled `Nav` back stack. Start: Enroll if no identity / blank entry URL / not onboarded, else Hub.

| Screen | File | ViewModel | Notes |
|---|---|---|---|
| Enroll | `ui/screens/EnrollScreen.kt` | none (container) | p12 + entry URL; 401 → cert refused; `https://` only |
| Hub | `ui/screens/HubScreen.kt` | `HubViewModel` (activity-scoped `key=hub`) | BottomRail tabs; Forget calls `shutdown()` on the same instance |
| Conversations | `ui/screens/ConversationsScreen.kt` | HubViewModel | recency list, pull-to-refresh, archive swipe, FAB draft |
| Agents | `ui/screens/AgentsScreen.kt` | HubViewModel | `/api/agents` presets (catalog fallback); tap / ↺ / + pointer semantics |
| Nodes | `ui/screens/NodesScreen.kt` | HubViewModel | view filter only; never rebinds an open chat; per-node error badge |
| Settings | `ui/screens/SettingsScreen.kt` | HubViewModel + container | identity, theme, terminal font; title long-press → gallery |
| Chat | `ui/screens/HarnessChatScreen.kt` | `HarnessChatViewModel` via `ScreenStores` | transcript, ask-user, composer, Chat\|Terminal swipe |
| Gallery | `ui/components/ComponentGallery.kt` | none | M1.5 preview |

Prefs keys (DataStore `rivethub`): `entryUrl`, `strictHostnames`, `onboarded`, `themeMode`
(`system`\|`light`\|`dark`), `sessionModes` (sessionId → `chat`\|`terminal`), `archived`,
`titleOverrides`, `agentPointers` (`sessionId\tnodeBaseUrl`), `terminalFontSp`, `viewNodeId`,
`currentAgentId`. Leftover Grok-Bot keys (`handle`, `pinned`, `hidden`, `sessionOverrides`,
`lastSeen`, `desktopUrl`) are still decoded so a wipe is not required; their setters are gone.

Chat VM is keyed `chat:<nodeDenUrl>:<sessionKey>` and torn down when that back-stack entry leaves.
Registry watches live in HubViewModel (one unlimited Channel, sequential consumer). SessionAttach
lives in the chat VM; WS frames are marshalled onto one Channel per attach (never `launch` per
frame). Turn-complete settle is deferred so it does not block frame intake. Network stays on
`Dispatchers.IO`. Identity `generation()` is sampled at start; a bump drops cached clients.

## Core packages

`gateway/`, `transport/`, and `plane/` stay free of `android.*` / `androidx.*` /
`com.android.*` imports (and fully-qualified `android.` / `androidx.` refs) so an iOS port can
share them behind a later Ktor swap. Enforced by `CorePackagesAreAndroidFreeTest`. `domain/` is
gone — its types live in `gateway/` + `plane/`. Screens talk to nodes only through `NodeTransport`
(`DirectTransport` today; `IngressTransport` is a later drop-in). Harness HTTP/WS is
`AppContainer.harness(denUrl)` (same OkHttp generation as Gateway). No KMP now.

## Harness plane (M3a + M3b)

Pure Kotlin under `gateway/HarnessWire.kt`, `gateway/HarnessGateway.kt`, and `plane/`. Desktop
semantics copied from `apps/rivethub-web` `harness-*.ts` + `ask-user.ts` + `attachments.ts` +
`outbound-pump.ts` + `agent-session.ts`. `+ new` is a bare UUID draft; never call startSession.
First send on a draft: `ensurePty` (`termSpawn` joined to the draft id) then `termInject`
(`POST /api/terminal/inject`; server appends `\r` via `submit` default true). Do **not** wait for
registry `session-created` — claude's store row is created by the first turn. After adopt,
`sendTurn`. LRU-evicted PTY: drop the pty ref, respawn, inject once more. API-only agent: commanded
spawn then `{ session }` fallback. Attachments are `[attached: uri]` lines after streaming
`POST /api/uploads` on the session's node (1 GiB cap, den-server). Canonical ids contain `:`; path
params are unpadded base64url (`sessionKeyEnc`). Hermes display/live strip stays
`data/HermesReasoning.kt`.

## Build / test / install

- Build host: the fleet's Android build box (JDK 21 + SDK 37 + warm Gradle cache) — host names and
  paths are ops notes in Rivet's memory, not here. `./gradlew :app:assembleDebug :app:testDebugUnitTest`.
  Full-suite test counts only — a `--tests` filter can match nothing and still print green; CI
  (`.github/workflows/android.yml`) enforces a floor of 204.
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
- `usesCleartextTraffic=false` (manifest). Enroll and Settings refuse non-`https://` entry URLs. A mesh
  node advertising `http://` still fails; that maps to `EnrollErrorKind.Cleartext`.
- Debug builds are `io.rivethub.app.debug`; release is `io.rivethub.app`. Both are fresh ids on the
  Pixel — import the device p12 once per build type. Note the session ring is keyed by the cert CN
  (`deviceTag()` = SHA-256 of the CN), so two installs sharing one p12 share one gateway session ring;
  give the debug install its own device cert if you need them independent.
- Transcript is raw `Text` (no markdown). Port `components/markdown.tsx` in M4/phase-2.
- Drafts are in-memory only (`HubViewModel` drafts list). A background-killed app loses unsent drafts
  and composer text. `+ new` is cheap; composer `rememberSaveable` is still open.
- Never cache a `Network` handle into anything long-lived; never freeze `Network.socketFactory` onto a client.
- No private IPs anywhere in this tree (CI secret-scan + private-net rule); placeholders use 192.0.2.x.
- `EncryptedSharedPreferences` is deprecated upstream; keep it until a Keystore-wrapped blob exists.
- Never send `{type:kill}` on terminal leave — detach only.
- M4 terminal: start from `git show 03682119:apps/rivethub-android/app/src/main/java/io/rivethub/app/ui/components/TerminalView.kt` rather than reinventing IME handling, resize maths, and OSC 52. `ui/term/AnsiTerminal.kt`, `gateway/TermWs.kt`, `data/TermClient.kt`, `ui/components/KeyToolbar.kt` are still in the tree. `DesktopView.kt` (noVNC) was a plan §1 non-goal; correct to stay deleted.
- ComponentGallery is still missing `statusBarsPadding()` (M1.5 emulator pass).
- `archived` / `sessionModes` / `titleOverrides` / `agentPointers` maps are not pruned when a session
  ends. Do not GC them on a partial discover.
