# AGENT.md — RivetHub (Android)

Continuity for `apps/rivet-android`. Keep short. No session diaries.

## What this is

Native Android RivetOS node (Kotlin / Compose): multi-LLM chat, on-device agents (proot), device control, optional WireGuard mesh, native node switching.

| | |
|--|--|
| Package | `dev.rivet.app` (debug `.debug`, friend `.friend`) |
| Namespace | `dev.rivet.*` · minSdk 26 · targetSdk 37 · AGPL-3.0 |
| Build | **Gradle** (not npm). `package.json` is nx graph only |
| Host | pve3 `/root/rivethub-monorepo-build` (JDK 21, SDK `/opt/android-sdk`) |

## Build

```bash
./gradlew :app:assemblePhilDebug
./gradlew :app:testPhilDebugUnitTest
# monorepo root:
nx apk @rivetos/rivet-android
```

- **phil** flavor: personal rootfs. **friend**: sanitized rootfs via `scripts/sanitize-rootfs.sh`.
- Rootfs is gitignored (`app/src/main/assets/rivet-rootfs.bin`). Never commit it.
- Debug APKs are ABI-split (`app-arm64-v8a-*.apk`). `./gradlew clean` after big asset changes.

## Architecture

**Modules:** `app` · `ai` · `common` · `speech` · `document` · `highlight` · `search` · `web` · `material3`

**Node / chat / terminal**

- Drawer **NodeSwitcher** sets active node — never opens hub WebView.
- Chat follows node via `NodeChatBackend`: local → `http://127.0.0.1:8765/v1` (bridge); remote → `{denUrl}/v1`.
- `activeNodeDenUrl` and Rivet provider `baseUrl` always move together.
- Terminal: local proot PTY · remote den WS. Chip for any Rivet agent session; resync is local-only.
- **Remote drawer list** = den `GET /api/terminal/harness-sessions` (node+harness scoped). Open imports transcript via `/harness-sessions/:id/transcript` into Room with **session id = conversation id** so Terminal escalate resumes the same join key.
- **Remote sync (phone ↔ desktop):** harness store is SoT for remote threads. Drawer re-fetches on open + 30s poll. Open chat soft-reimports on resume, every 15s, and on menu Resync (force). Skips rewrite when already aligned / mid-generation. Still dual-path for *send* (phone `/v1` vs desktop inject) — live WS + inject send is follow-up.

**Runtime:** proot/busybox/dropbear jniLibs · bridge `:8765` · optional full runtime den `:5174` · a11y control `:9876` · mesh config in Settings (no `RIVET_*` BuildConfig secrets).

## Gotchas

1. proot loader path is **applicationId-specific** — use `scripts/fix-rootfs-proot-loader.sh` per flavor.
2. Termux proot hardcodes loader path — binary-patched + symlink in scaffold.
3. `TerminalPage.kt` has a NUL in a key separator — `grep -a`.
4. Avoid `/*` inside KDoc (nested block-comment trap).
5. Do not reintroduce Firebase or baked mesh BuildConfig fields.
