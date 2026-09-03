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
change**: the Grok-Bot screens still compile and the 29 JVM tests still mean something. Everything
`Bot*`-named in `domain/` and `ui/` is scheduled for deletion in M3a/M3b (desktop-mirroring screens on
the harness control plane) — do not invest in it.

What survives into the real app (plan §2): `data/DeviceIdentity.kt` (p12 vault), `data/HttpFactory.kt`
+ `data/LanNetwork.kt` + `LiveLanSocketFactory` (dual-path networking, `ACCESS_LOCAL_NETWORK`),
`data/Gateway.kt` (reconnecting WS), `data/Wire.kt` (gateway twins — harness-plane twins are ADDED in M3a,
these are not reused), the turn state machine in `ui/ChatViewModel.kt`, `HermesReasoning.kt`,
`ui/term/AnsiTerminal.kt` + the OSC colour-query filter, theme plumbing.

## Slices (plan §6)

M1a rename + M6 CI ✔ (this) → M1b `NodeTransport` seam + android-free `domain/gateway/transport` + nx
`project.json` → M2a p12 import in Settings → M1.5 design system (desktop tokens + components, Claude
Design canvas = acceptance) → M3a pure-Kotlin plane layer (tests only) → M3b Compose conversations +
chat → M4 terminal mode → M5a nodes filter → M5b turn-complete notification → M7 cutover.

## Build / test / install

- Build host: the fleet's Android build box (JDK 21 + SDK 37 + warm Gradle cache) — host names and
  paths are ops notes in Rivet's memory, not here. `./gradlew :app:assembleDebug :app:testDebugUnitTest`.
  Full-suite test counts only — a `--tests` filter can match nothing and still print green; CI enforces
  a floor of 29 (bump it deliberately when the suite grows).
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

- Harness canonical ids contain `:`; the surviving **gateway** ring ids (`Bot.defaultSessionId`) still
  must NOT, until M3a deletes that path.
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
