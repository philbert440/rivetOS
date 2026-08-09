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
- **Remote drawer list** = control plane `GET /api/harnesses/:id/sessions` ∪ legacy `GET /api/terminal/harness-sessions`, keyed by bare native id, plane wins (`HarnessPlaneRepository`). Open imports transcript into Room with **session id = conversation id** so Terminal escalate resumes the same join key.
- **Harness control plane** (`data/harness/`): per-session plane selection, same rule as RivetHub web. A row a registered driver claims sends via `POST /api/harness-sessions/<enc>/turns`, tails `WS /api/harness-sessions/ws?session=<enc>`, and **hard-resyncs its transcript on every socket open** (the tail is at-most-once, no replay) and after `turn-complete`. `<enc>` = unpadded base64url of `<harness-id>:<native>`. Stop button only when the driver reports `interrupt`; no approval UI (both PTY drivers report `approvals:false`). Everything else — unclaimed rows, drafts, local node — keeps the `/v1` path unchanged; a node with no `/api/harnesses` behaves exactly as before. No legacy toggle.
- **Remote sync (phone ↔ desktop):** harness store is SoT for remote threads. Drawer re-fetches on open + 30s poll. An **unbound** chat soft-reimports on resume, every 15s, and on menu Resync (force). A chat whose driver reports `liveStream` does not poll — its socket pushes and every (re)open hard-resyncs; bound-but-streamless still polls, and a terminally-dead stream un-binds the thread so the poll resumes. Which harnesses are driver-owned is read off `GET /api/harnesses` at runtime — no app change was needed when the hermes driver landed. Deferred: attachments on a bound turn (refused, not silently dropped — `POST /api/uploads` is implemented client-side but no driver consumes a staged URI), `session-created` fast path (web has one, this does not), `startSession` from the app.

- **Per-node gateway bearer** (`data/node/`): pasted per node in the switcher sheet (Add form + key button), the same affordance as RivetHub web's Settings field. Kept in its OWN app-private prefs file (`rivet_node_tokens`), keyed by normalized den URL — **never on `RosterNode`**, because `Settings` is serialized into `settings.json` and uploaded by the WebDAV/S3 backup. Excluded from cloud backup + device transfer; never logged. Supplied through `HarnessPlaneRepository.tokenFor` to the control plane, the legacy scan, and the remote terminal. A 401 still degrades to legacy; the row says *which* 401 it is — no token, rejected token, or a token this node accepted before and has since rotated (`rivetos gateway token --rotate`). Removing a node removes its bearer.

**Runtime:** proot/busybox/dropbear jniLibs · bridge `:8765` · optional full runtime den `:5174` · a11y control `:9876` · mesh config in Settings (no `RIVET_*` BuildConfig secrets).

## Gotchas

1. proot loader path is **applicationId-specific** — use `scripts/fix-rootfs-proot-loader.sh` per flavor.
2. Termux proot hardcodes loader path — binary-patched + symlink in scaffold.
3. `TerminalPage.kt` has a NUL in a key separator — `grep -a`.
4. Avoid `/*` inside KDoc (nested block-comment trap).
5. Do not reintroduce Firebase or baked mesh BuildConfig fields.
6. Secrets never go in `Settings` — that whole object is serialized to `settings.json` and uploaded by the WebDAV/S3 backup. Use the `rivet_node_tokens` prefs file, and keep it in the backup exclusion rules.
