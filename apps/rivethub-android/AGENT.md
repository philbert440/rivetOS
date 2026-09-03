# AGENT.md — rivethub-android

Live state for whoever picks this up next (any model). Keep short; no session diaries.

## What this is

**RivetHub for Android** (`io.rivethub.app`, Apache-2.0, Kotlin/Compose): the desktop RivetHub app,
phone-shaped — same look/feel, same den backend, same harness-session model, device mTLS only, nothing
runs on the phone. Off-LAN via the stock Tailscale app. The plan of record is
`/rivet-shared/plans/rivethub-android-2026-09-02.md` (v2, reviewed); read it before changing anything.

## Where this tree came from (slice M1a, 2026-09-03)

`git mv` of `apps/rivet-bots-android` (the Grok-Bot-style client, package `dev.rivetos.bots`) with the
package renamed to `io.rivethub.app`, label "RivetHub", DataStore file "rivethub". **Zero behaviour
change**: the Grok-Bot screens still compile and the 172 JVM tests still mean something. Everything
`Bot*`-named in `domain/` and `ui/` is scheduled for deletion in M3b (desktop-mirroring screens on
the harness control plane) — do not invest in it.

What survives into the real app (plan §2): `data/DeviceIdentity.kt` (p12 vault), `data/HttpFactory.kt`
+ `data/LanNetwork.kt` + `LiveLanSocketFactory` (dual-path networking, `ACCESS_LOCAL_NETWORK`),
`gateway/Gateway.kt` (reconnecting WS), `gateway/TermWs.kt`, `gateway/GatewayClients.kt` (injected
OkHttp split), `gateway/Wire.kt` (gateway twins — not reused by the plane), `gateway/HarnessWire.kt`
+ `gateway/HarnessGateway.kt` (M3a), `plane/` (M3a, android-free), `transport/NodeTransport` +
`DirectTransport` (screens obtain gateways only through this seam), the turn state machine in
`ui/ChatViewModel.kt`, `HermesReasoning.kt` (reused by the plane, not duplicated),
`ui/term/AnsiTerminal.kt` + the OSC colour-query filter, theme plumbing.

## Slices (plan §6)

M1a rename + M6 CI ✔ → M1b `NodeTransport` seam + android-free `domain/gateway/transport` + nx
`project.json` ✔ → M2a p12 import in Settings → M1.5 design system ✔ (`ui/theme` + `ui/components`,
gallery behind Settings-title long-press) → **M3a pure-Kotlin plane layer (tests only) ✔ (this)** → M3b Compose conversations +
chat → M4 terminal mode → M5a nodes filter → M5b turn-complete notification → M7 cutover.

## Core packages

`domain/`, `gateway/`, `transport/`, and `plane/` stay free of `android.*` / `androidx.*` /
`com.android.*` imports (and fully-qualified `android.` / `androidx.` refs) so an iOS port can
share them behind a later Ktor swap. Enforced by `CorePackagesAreAndroidFreeTest`. Screens talk
to nodes only through `NodeTransport` (`DirectTransport` today; `IngressTransport` is a later
drop-in). No KMP now.

## Harness plane (M3a)

Pure Kotlin under `gateway/HarnessWire.kt`, `gateway/HarnessGateway.kt`, and `plane/`. Unit
tests only — no Compose, no screen changes. Desktop semantics copied from
`apps/rivethub-web/src/lib/harness-*.ts` + `ask-user.ts` + `attachments.ts` + `outbound-pump.ts`
+ `agent-session.ts`. `+ new` is a bare UUID draft; never call startSession (hermes/kimi/dsh
refuse it). Attachments are `[attached: uri]` lines after `POST /api/uploads` on the session's
node. Canonical ids contain `:`; path params are unpadded base64url (`sessionKeyEnc`).
`SessionResolver` still reads the gateway ring (omits zero-message sessions) — M3b deletes it.
Hermes display/live strip stays `data/HermesReasoning.kt`.

## Build / test / install

- Build host: the fleet's Android build box (JDK 21 + SDK 37 + warm Gradle cache) — host names and
  paths are ops notes in Rivet's memory, not here. `./gradlew :app:assembleDebug :app:testDebugUnitTest`.
  Full-suite test counts only — a `--tests` filter can match nothing and still print green; CI
  (`.github/workflows/android.yml`) enforces a floor of 172 (bump it deliberately when the suite grows; M3a added 113 plane/wire tests, M3a-fix2 added 21).
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

- Deferred from M1.5 (recorded here, not only in the fix notes): snackbar/toast host, `ModePager` swipe (placeholder only), `Composer.enabled=false` also disables Stop, `SelectOption.group` for grouped selects, `RivetConfirmDialog` title param, 44-dp targets on `FilterChipRow`/select trigger, `RivetSelect` `sheetState.hide()` before dismiss, `lint-android` not yet run in CI.

- Harness canonical ids contain `:`; the surviving **gateway** ring ids (`Bot.defaultSessionId`) still
  must NOT, until M3b deletes `SessionResolver` / that path.
- `usesCleartextTraffic=true` exists only for the noVNC Desktop tab (a non-goal, plan §1); flip it to
  false when `ui/components/DesktopView.kt` is deleted in M3b.
- Deferred to M1.5 on purpose: `Theme.RivetBots` / `RivetBotsTheme` identifiers (theme is replaced
  wholesale there). `package.json` version tracks the monorepo release train, not `versionName`.
- Debug builds are `io.rivethub.app.debug`; release is `io.rivethub.app`. Both are fresh ids on the
  Pixel — import the device p12 once per build type. Note the session ring is keyed by the cert CN
  (`deviceTag()` = SHA-256 of the CN), so two installs sharing one p12 share one gateway session ring;
  give the debug install its own device cert if you need them independent.

- Never cache a `Network` handle into anything long-lived; never freeze `Network.socketFactory` onto a client.
- No private IPs anywhere in this tree (CI secret-scan + private-net rule); placeholders use 192.0.2.x.
- `EncryptedSharedPreferences` is deprecated upstream; keep it until a Keystore-wrapped blob exists.
- Never send `{type:kill}` on terminal leave — detach only.
