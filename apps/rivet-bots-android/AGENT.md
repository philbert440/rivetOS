# AGENT.md — rivet-bots-android

Live state for whoever picks this up next (any model). Update as you go.

## What this is

Android (Kotlin/Compose, Apache-2.0) UI clone of **Grok Bot for iOS**, re-pointed at
the Rivet mesh: each bot = one agent on one node. Package `dev.rivetos.bots`, app
label "Rivet Bots". Built 2026-08-24 from scratch (no RikkaHub code).

## Layout

```
app/src/main/java/dev/rivetos/bots/
  BotsApp.kt            Application + AppContainer (settings, identity, http, gateways, repo)
  MainActivity.kt       App() — hand-rolled back stack (ui/Nav.kt), screen switch, ViewModel wiring
  domain/Bot.kt         Bot (agent,node,denUrl,online,provider,model), BotLooks (face colour/shape per agent)
  data/Wire.kt          @Serializable twins of @rivetos/types gateway-api.ts + den-protocol; WS frame parsers
  data/DeviceIdentity.kt  PKCS#12 store (filesDir) + passphrase vault (EncryptedSharedPreferences); KeyManager/TrustManager
  data/HttpFactory.kt   OkHttp client with device mTLS; strict-hostname toggle
  data/Gateway.kt       typed client: healthz/mesh/catalogAgents/sessions/messages/post/denState + reconnecting WS
  data/Settings.kt      DataStore prefs: entryUrl, extraNodes, handle, strict, pinned, hidden, sessionOverrides, lastSeen, botEdits
  data/BotEdit.kt       local name/color/shape override; Bot.effective(edit)
  data/BotRepository.kt discover(entry, extras) → List<Bot>; preview; resolveSessionId; nodeSessions
  data/SessionResolver.kt  first-open adopt + merge(/api/sessions + den names); Chat/Computer share it
  ui/HomeViewModel.kt   roster + previews + one all-sessions WS per online node; pin/hide/markSeen
  ui/ChatViewModel.kt   thread + stream state machine; first-open adopt; open(sid) follows override
  ui/ComputerViewModel.kt Terminal-default; den + PTY; switchSession rebinds watches (no nav re-key)
  ui/screens/           SignIn, Enroll, Home, Chat, Computer, Profile, EditBot, Settings
  ui/components/        BlobAvatar (Canvas faces), CircleIconButton, BotPill, PulsingDot, TimeFmt
```

## Build / stage / install (proven 2026-08-24)

- Build host: the fleet's Android build box (JDK 21 + SDK 37 + warm Gradle cache). rsync this dir
  there and run `./gradlew :app:assembleDebug` (~2 min cold, seconds warm); `:app:testDebugUnitTest`
  for the JVM tests; `:app:assembleRelease` to exercise R8. Host names, staging paths, the debug
  keystore, and where the device p12/passphrase live are **ops notes in Rivet's memory**, not here.
- Emulator smoke (proven): x86_64 `system-images;android-36;google_apis` under KVM, `-no-window
  -gpu swiftshader_indirect`; drive with `adb shell input` + `uiautomator dump`. Enroll with any
  Rivet-CA device p12 packed as `openssl pkcs12 -export -certfile chain.pem …`.

## Verified end-to-end (2026-08-24, emulator against a live mesh)

Enroll with a real device p12 → roster of 10 bots across 8 nodes → two turns to Claude on a live node
answered and rendered (stream chip → committed message) → home preview + time updated over the
all-sessions WS → Computer screen shows the (empty) room. Cold claude-cli spawn on a node can take
~2 min; the working chip has a 3-minute idle deadline (re-armed by every stream frame) with transcript refetches.

## Contract facts verified against live nodes (2026-08-24)

- `GET /api/mesh` → `{updatedAt, nodes:[{id,name,denUrl,online,sessions}]}` ✔
- `GET /api/catalog/agents` → `{agents:[{id,node,local,provider?,model?}]}` ✔ — remote agents only
  appear when the owning node advertised `agentDetails`; nodes missing from the catalog are probed
  individually (`BotRepository.probeNode`), and a den-only node (no chat gateway) is dropped because
  `/api/sessions` isn't served there.
- Off-loopback requests without a device client cert → 401 `{"error":"unauthorized"}`; `/healthz` is open.
- Den rooms are keyed by the harness's den session; a gateway turn on a node whose harness doesn't
  emit den events under the gateway session id leaves the Computer view on the empty room. Wiring
  that mapping is node-side work (den hooks), not app work.
- Node leaf certs carry `IP:<lan>` + `IP:127.0.0.1` SANs, so strict hostname verification works.
- `GET /api/sessions` omits sessions with zero messages — expected; previews come from
  `/api/sessions/:id/messages` per bot.

## Hermes reasoning box (2026-08-24)

Hermes TUI paints `┌─ Reasoning ──┐` plus the thinking text into `assistant_response`.
The den hook, gateway bridge, harness transcript read, and this app all strip it
(`splitHermesReasoning` / `HermesReasoning.kt`). Live stream shows `Thinking…`; the
bubble is the reply only. Already-stored boxed rows are cleaned on display.

## Entry node (datahub)

The normal **entry URL** on Sign-in / Enroll is the **datahub gateway** (device
setup + mesh roster). Discovery is `GET /api/mesh` on that entry, then each bot
talks to its node's own `denUrl` for sessions / chat / den / terminal. Do not
point the entry URL at a leaf node's chat gateway unless you mean to.

## Open items / next

1. **Physical-device smoke** (emulator pass is done): install the staged debug APK from the adb host,
   enroll with the phone's own device p12, repeat the emulator checklist.
2. Voice: the composer's mic is a placeholder (Grok Bot has dictation). GERTY ASR (:9000) is the obvious backend.
3. Approvals: Grok Bot surfaces approve/deny cards; our gateway has `/api/harness-sessions` approvals — not wired.
4. Routines on the profile screen ↔ `/api/tasks` / workflows — not wired.
5. `confirmValueChange` on SwipeToDismissBox is deprecated in this Material3; still works, revisit when M3 drops it.
6. Push notifications — nothing yet; WS previews only update while the app is foregrounded.
7. Review round 1 (grok + kimi, 2026-08-24) applied: per-screen VM stores, session-filtered frames,
   transcript merge on (re)connect, single-socket reconnect, watches keyed by identity generation,
   identity parse errors surfaced, base-path-safe URLs, Computer never shows another room.
   Deferred from that round: markdown rendering, thinking transcript, approvals cards, CharArray
   passphrase plumbing, union-with-platform trust.
8. **Desktop tab → remote-control client** (not built): replace the noVNC WebView
   with a full RDP/VNC client (pointer, keyboard, clipboard) and **session
   capture for teaching skills via the UI** — record the interaction and turn it
   into skill artifacts. Roadmap only.

## Gotchas

- **Two network paths per gateway** (`HttpFactory.client(strict, bindLan)` → `Gateway.withClients`):
  primary = the default network (Android routing, including an active VPN/WG), fallback = a
  `LiveLanSocketFactory` that re-resolves `LanNetwork.current()` inside every `createSocket` (grok's
  A/B proved a `Network.socketFactory` frozen onto a long-lived client dies with its netId on an
  SSID/band hop — SYN-SENT, zero packets on the wire, while shell `nc` from the same phone works).
  `current()` scans `allNetworks` preferring a WIFI/ETHERNET net that already holds a private IPv4.
  HTTP calls retry once on the other path after a connect failure and the gateway sticks with the
  winner; the WS alternates paths per reconnect attempt. Never cache a `Network` handle into anything
  long-lived.

- Don't hardcode mesh IPs anywhere in this tree (repo CI secret-scan + private-net rule); placeholders use 192.0.2.x.
- `EncryptedSharedPreferences` is deprecated upstream but is what the sibling Hub app uses; swap for a
  Keystore-wrapped blob when androidx ships the replacement.
- Session ids must not contain `:` (the gateway treats `harness:…` as a canonical SessionId).
- ComputerViewModel.openDirtyWatch holds a node-wide `/api/sessions/ws` (null
  session filter) for `sessions-dirty` while Computer is open. HomeViewModel
  already has one all-sessions WS per online node, and it stays alive under
  Computer. That is two reconnecting sockets per node (three with Chat's
  per-session watch). Accepted: store scoping makes reuse messy; do not
  restructure the watchers.

## Computer tabs (Terminal / Activity / Desktop) — 2026-08-24

`ComputerScreen` is three tabs. Public entry is unchanged: `ComputerScreen(vm, bot, onBack, onProfile)`.
Default tab is **Terminal** (`ComputerTab` order is Terminal, Activity, Desktop).
`ensureTerm()` runs from `selectTab`, from init after the session is adopted, and
from a `LaunchedEffect` keyed on `sessionReady` so a first composition already
on Terminal still attaches.

- **Terminal** — spawn-or-get `POST /api/terminal` with `{session, cols, rows}` then attach `WS /api/terminal/ws?id=`. Query params verified in den-server `term/ws.ts`: `id` or `session`. Framing: JSON hello → one binary scrollback → live binary → JSON exit. Client sends binary keystrokes and JSON `{type:resize}`; never `{type:kill}` (detach on leave). Dual-path mTLS via `TermWs` (`data/TermClient.kt`) using `Gateway.clients()`. Pure-Kotlin VT in `ui/term/AnsiTerminal.kt` (SGR 16/256/truecolor + bold, CR/LF/BS/TAB, ED/EL, CUP/CUU/CUD/CUF/CUB). OSC 10/11/12 color queries stripped; reports never forwarded. 5k-line scrollback, pinch font, tap IME, Esc/Tab/Ctrl+C/arrows.
- **Activity** — den RoomState body (bezel + plan + den `term` tail + last said) plus the **node session list** (`GET /api/sessions`, den snapshot names overlaid). Tapping a row or **New session** persists `setSessionOverride` and `ComputerViewModel.switchSession` rebinds den + PTY. List refreshes on Activity select, ON_RESUME, `sessions-dirty`, and den events.
- **Desktop** — `Prefs.desktopUrl` (`Settings.setDesktopUrl`). Unset → inline field, placeholder `http://192.0.2.30:6080/vnc.html`. WebView (JS, wide viewport) stays composed at full size under the other tabs so noVNC survives switches; navigation locked to that host. Manifest `usesCleartextTraffic=true` is temporary until the desktop is behind TLS. Destined to become a native RDP/VNC client with session capture (roadmap #8); not built.

## Session-first Computer (phase 3)

A bot with no override used to mint `rivetbots-<tag>-<node>-<agent>` and spawn a
brand-new PTY. Chat and Computer now share `BotRepository.resolveSessionId` →
`SessionResolver.adopt`: override wins; else most-recent `GET /api/sessions`
row (persist it); else mint, persist only when the node really returned an
empty list. Failed fetch does not persist, so the next open retries.

`switchSession` (not a nav storeKey change) is how selection rewires Computer:
the public composable signature stays the same, and one VM owns close/reset/reopen
of the den watch, TermWs, and AnsiScreen. Chat follows the new override via
`MainActivity` `LaunchedEffect(override)` → `ChatViewModel.open(sid)` when the
user returns to the thread.

## Bot edits (local, 2026-08-24)

Display name + blob color/shape are device-local (`Prefs.botEdits`, keyed by
`bot.id`). No gateway API. `Bot.effective(edit)` is the one lookup; Compose
reads `LocalBotEdits` so Home / Chat / Computer / Profile / BotPill stay in
sync after save. Profile → Edit. Renames do not change `bot.id` or
`defaultSessionId`.
