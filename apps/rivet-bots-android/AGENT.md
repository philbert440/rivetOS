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
  data/Settings.kt      DataStore prefs: entryUrl, extraNodes, handle, strict, pinned, hidden, sessionOverrides, lastSeen
  data/BotRepository.kt discover(entry, extras) → List<Bot>; preview(bot, sessionId)
  ui/HomeViewModel.kt   roster + previews + one all-sessions WS per online node; pin/hide/markSeen
  ui/ChatViewModel.kt   thread + stream state machine (text/reasoning/tool_*/done), optimistic send, new conversation
  ui/ComputerViewModel.kt den RoomState via state fetch + events WS (debounced refetch)
  ui/screens/           SignIn, Enroll, Home, Chat, Computer, Profile, Settings
  ui/components/        BlobAvatar (Canvas faces), CircleIconButton, BotPill, PulsingDot, TimeFmt
```

## Build / stage / install (proven 2026-08-24)

- Build host: **pve3** `/opt/work/rivet-bots-build/` (rsync of this dir; `/opt/work` has room, `~/.gradle` warm).
  ```
  rsync -a --delete --exclude build/ --exclude .gradle/ --exclude .kotlin/ --exclude local.properties \
        apps/rivet-bots-android/ pve3:/opt/work/rivet-bots-build/
  ssh pve3 'cd /opt/work/rivet-bots-build && JAVA_HOME=/usr ANDROID_HOME=/opt/android-sdk \
        ANDROID_SDK_ROOT=/opt/android-sdk ./gradlew :app:assembleDebug --console=plain'   # ~2m
  ```
- Staged: `/rivet-shared/rivet-phone/apk/rivet-bots-debug.apk` (+ SHA256SUMS).
- Install from **phildesk** only (standing rule): `adb install -r /rivet-shared/rivet-phone/apk/rivet-bots-debug.apk`.
  New package id → no keystore/wipe concern; debug key is pve3's `/root/.android/debug.keystore` (SHA1 913d…8d15).
- Device p12: `/rivet-shared/rivet-ca/issued/device-pixel-phil.p12` (expires 2026-11-08);
  passphrase in Rivet's 1Password → "Rivet device cert p12 passphrase".

## Contract facts verified against live nodes (2026-08-24, ct115)

- `GET /api/mesh` → `{updatedAt, nodes:[{id,name,denUrl,online,sessions}]}` ✔
- `GET /api/catalog/agents` → `{agents:[{id,node,local,provider?,model?}]}` ✔ — remote agents only
  appear when the owning node advertised `agentDetails`; nodes missing from the catalog are probed
  individually (`BotRepository.probeNode`), and a den-only node (datahub) is dropped because
  `/api/sessions` isn't served there.
- Off-loopback requests without a device client cert → 401 `{"error":"unauthorized"}`; `/healthz` is open.
- Node leaf certs carry `IP:<lan>` + `IP:127.0.0.1` SANs, so strict hostname verification works.
- `GET /api/sessions` omits sessions with zero messages — expected; previews come from
  `/api/sessions/:id/messages` per bot.

## Open items / next

1. **On-device smoke** (blocked on the Pixel being USB'd to phildesk): enroll with the pixel-phil p12,
   confirm roster, send a turn to Claude@ct115, watch the Computer view.
2. Voice: the composer's mic is a placeholder (Grok Bot has dictation). GERTY ASR (:9000) is the obvious backend.
3. Approvals: Grok Bot surfaces approve/deny cards; our gateway has `/api/harness-sessions` approvals — not wired.
4. Routines on the profile screen ↔ `/api/tasks` / workflows — not wired.
5. `confirmValueChange` on SwipeToDismissBox is deprecated in this Material3; still works, revisit when M3 drops it.
6. Push notifications — nothing yet; WS previews only update while the app is foregrounded.

## Gotchas

- Don't hardcode mesh IPs anywhere in this tree (repo CI secret-scan + private-net rule); placeholders use 192.0.2.x.
- `EncryptedSharedPreferences` is deprecated upstream but is what the sibling Hub app uses; swap for a
  Keystore-wrapped blob when androidx ships the replacement.
- Session ids must not contain `:` (the gateway treats `harness:…` as a canonical SessionId).
