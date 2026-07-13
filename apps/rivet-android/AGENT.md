# AGENT.md — RivetHub (Android)

Continuity doc for any agent working on `apps/rivet-android`. Keep this short and current.

## What this is

RivetHub is a native Android (Kotlin / Jetpack Compose) **self-contained RivetOS node**: multi-LLM chat, on-device agent runtime (proot rootfs), accessibility device control, optional WireGuard mesh, and native node switching.

- **Canonical tree:** RivetOS monorepo `apps/rivet-android` (not a submodule).
- **Package:** `dev.rivet.app` (debug: `.debug`; friend flavor: `.friend`).
- **Namespace:** `dev.rivet.*`. minSdk 26, targetSdk 37. AGPL-3.0 (derived from [RikkaHub](https://github.com/rikkahub/rikkahub)).
- **Build:** Gradle (not npm/nx). `package.json` only registers the project in the nx graph.

## Build / deploy

Headless build host: **pve3** `/root/rivethub-monorepo-build` (JDK 21, SDK `/opt/android-sdk`).

```bash
# From apps/rivet-android (or monorepo root via nx wrappers)
./gradlew :app:assemblePhilDebug
./gradlew :app:testPhilDebugUnitTest
./gradlew :app:lintPhilDebug

# nx (from monorepo root) — targets deliberately not named build/test/lint
nx apk @rivetos/rivet-android          # assemblePhilDebug
nx check @rivetos/rivet-android
nx verify @rivetos/rivet-android
nx apk-release @rivetos/rivet-android
```

**Flavors**

| Flavor | Purpose |
|--------|---------|
| `phil` | Personal rootfs asset (default) |
| `friend` | Sanitized shareable rootfs (`src/friend/assets/`); needs `scripts/sanitize-rootfs.sh` |

Rootfs is **never committed** (`app/src/main/assets/rivet-rootfs.bin` gitignored). Signing keystore stays on the build host.

**ABI note:** debug APKs are split — look for `app-arm64-v8a-*.apk`, not a single `app-debug.apk`. After big asset changes run `./gradlew clean` or packaging keeps dead slack.

## Architecture (current)

### Modules

| Module | Role |
|--------|------|
| `app` | UI, ViewModels, Room, runtime, device control, VPN |
| `ai` | Provider SDK (OpenAI / Google / Anthropic) |
| `common` | HTTP/cache helpers |
| `speech` | TTS / ASR |
| `document` | PDF/DOCX/etc (MuPDF) |
| `highlight` | Syntax highlighting |
| `search` | Web-search providers (tooling; no dedicated search UI) |
| `web` | Embedded Ktor helpers used by in-app web API |
| `material3` | Material color utilities (vendored **kotlin only**) |

### Node / chat / terminal (post-#380/#381/#382)

- **Node switcher** (drawer): picks active node. **Never** opens hub WebView on select.
- **Native chat** follows the active node via `NodeChatBackend`:
  - Local den (`127.0.0.1:5174` / localhost) → Rivet provider `baseUrl` = `http://127.0.0.1:8765/v1` (on-device bridge)
  - Remote den → `{denUrl}/v1` (den OpenAI-compat surface, #381)
- **Invariant:** `Settings.activeNodeDenUrl` and Rivet provider `baseUrl` always move together (atomic switch; upgrade reconcile in `RivetHubApp`).
- **Terminal:**
  - Local → proot PTY (`RivetRuntime.terminalCommand`)
  - Remote → den WS (`DenTermClient` / `RemoteTermSession`)
  - Chat top-bar **Terminal chip** shows for any Rivet agent-session provider; **resync** remains local-bridge only.

### Runtime on device

- proot + busybox + dropbear under app uid (jniLibs).
- Bridge asset: `assets/rivet-bridge-server-v2.js` → loopback `:8765`.
- Full monorepo runtime (optional provision): den `:5174`, overlays under `assets/rivet-*-overlay.bin`.
- Device control: accessibility service + loopback `:9876`.
- Mesh: `MeshConfig` in Settings → Node & Mesh (nothing environment-specific baked into BuildConfig).

## What we intentionally cut / keep

**Removed from product surface (2026-07 cleanup):** drawer **Translator** and **Stats** (pages + routes deleted). Donate/nag/Firebase/update-checker were removed in Phase 0.

**Still present on purpose**

- Message search (`Screen.MessageSearch` / `SearchPage`) — local conversation search, not web search.
- `:search` module + `enableWebSearch` — agent tool path, not a first-class UI.
- `me.rerere.hugeicons` / other JitPack `rikkahub/*` deps — upstream library coordinates.
- Dual markdown (`Markdown.kt` + `MarkdownNew.kt`) — HTML path uses New; non-HTML uses Classic. Split later when touching richtext.

## Gotchas (still true)

1. **proot loader path is applicationId-specific** — release/friend patches live under flavor jniLibs; don’t copy one flavor’s `libproot.so` into another without `scripts/fix-rootfs-proot-loader.sh`.
2. **Termux proot hardcodes loader path** — we binary-patch + symlink via `setupRuntimeScaffold`.
3. **TerminalPage.kt contains a NUL byte** in a key separator — use `grep -a` / binary-safe tools.
4. **Kotlin nested block comments** — avoid `/*` inside KDoc paths.
5. **Incremental packaging bloat** — `gradlew clean` before measuring APK size.
6. **ADB/USB** flaky when phone sleeps — `adb shell svc power stayon true`.
7. **Do not reintroduce** `RIVET_*` BuildConfig mesh secrets or Firebase.

## Open / deferred

- Device smoke of node switch (local ↔ remote chat + terminal + status dots) after #380–#382.
- ProGuard real obfuscation (`-dontobfuscate` still on) — needs signed release smoke.
- Split god files when next touched: `ChatService`, `SettingProviderDetailPage`, `RivetRuntime`, `PreferencesStore`.
- `sponsorAlertDismissedAt` / unused datastore leftovers — safe to drop on next prefs pass.
- God-file and markdown dual-engine cleanup (not blocking).

## Docs map

| File | Use |
|------|-----|
| `AGENT.md` (this) | Live continuity |
| `CLAUDE.md` | Module map + Compose conventions |
| `README.md` | Human-facing overview |
| `RIVET-AGENT-RUNTIME-PLAN.md` | Historical runtime plan (archive) |

Do **not** re-grow this file into a session diary. Put dated notes in memory or a dated log outside the tree.
