# RivetHub device control (v0.2)

Canonical on-device control API for agents in the proot rootfs.

**This file is rewritten on every RivetHub app launch** from the APK asset
(`device-control.md`). Do not rely on hand-edits surviving a relaunch.

Fidelity upgrades land incrementally. **Feature-detect via `GET /status` →
`capabilities`** — do not assume endpoints from older notes.

---

## Endpoint

- **Bind:** loopback only — `127.0.0.1:9876` (not reachable from the network).
- **Auth:** every call except `GET /status` requires header  
  `X-Rivet-Token: <token>`
- **Token + port:** `~/.rivet/control.json` (refreshed every launch):

```sh
TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' ~/.rivet/control.json)
```

Desktop debugging: `adb forward tcp:9876 tcp:9876`.

---

## Endpoints (v0.2)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/status` | none | Health + `mode`, `capabilities`, optional `display`, WG |
| GET | `/ui` | token | Flat a11y `nodes[]` (maxDepth 12); blocked when `parked` |
| GET | `/screenshot` | token | Scaled JPEG; default `dest=file` → `~/.rivet/screenshots/last.jpg` |
| POST | `/action` | token | click, swipe, text, global, node_click, launch, intent; `full` only |
| POST | `/notify` | token | High-priority agent alert notification (all modes) |
| POST | `/mode` | token | Set `full` \| `eyes` \| `parked` |
| POST | `/exec` | token | **DEBUG builds only** — blocked in eyes/parked |

### GET `/status` (no token)

```sh
curl -s 127.0.0.1:9876/status
```

Useful fields:

- `ok`, `accessibility_connected`, `current_package`, `port`
- `version` — `"0.2.0"`
- `mode` — `full` \| `eyes` \| `parked`
- `capabilities` — nested feature flags (schema 1); prefer this over guessing
- `display` — `{width,height,densityDpi}` when available
- WireGuard keys as before

If `accessibility_connected` is false, UI/screenshot/action calls return **503**
(`error: a11y_disconnected`) until Rivet Accessibility is enabled.

### Control modes (kill-switch)

```sh
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"parked"}' 127.0.0.1:9876/mode
```

| Mode | `/status` | `/ui` | `/screenshot` | `/action` | `/notify` | `/exec` |
|------|-----------|-------|---------------|-----------|-----------|---------|
| `full` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (DEBUG) |
| `eyes` | ✓ | ✓ | ✓ | **403** | ✓ | **403** |
| `parked` | ✓ | **403** | **403** | **403** | ✓ | **403** |

- Default: `full` (persisted in app prefs).
- Response on block: HTTP **403**, `error: forbidden_mode`.
- `/mode` is always allowed so you can unpark.
- Parked/eyes never capture screenshots or update `last.jpg`.

### GET `/screenshot`

```sh
# Agent default: write last.jpg into the proot home (no base64)
curl -s -H "X-Rivet-Token: $TOKEN" \
  '127.0.0.1:9876/screenshot?scale=0.4&quality=70&dest=file'

# Meta + base64 only (no file)
curl -s -H "X-Rivet-Token: $TOKEN" \
  '127.0.0.1:9876/screenshot?dest=json'

# Raw JPEG body
curl -s -H "X-Rivet-Token: $TOKEN" \
  '127.0.0.1:9876/screenshot?dest=raw' -o /tmp/shot.jpg
```

| Query | Default | Description |
|-------|---------|-------------|
| `scale` | `0.4` | Linear scale, clamped 0.1–1.0 (also capped so max edge ≤ 1280) |
| `quality` | `70` | JPEG quality 1–100 |
| `format` | `jpeg` | **jpeg only** — other values → 400 `bad_request` |
| `display` | `0` | Display id (`Display.DEFAULT_DISPLAY`) |
| `dest` | **`file`** | `file` write guest path; `json` meta+base64; `raw` image/jpeg body |
| `include_base64` | `0` | With `dest=file`, set `1` to also embed base64 (discouraged) |

**`dest=file` (default)** writes **only**  
`/home/rivet/.rivet/screenshots/last.jpg` (overwrite; no history). Guest path in
JSON `path`. Host path is under the app rootfs dir.

Success JSON shape:

```json
{
  "ok": true,
  "width": 432,
  "height": 960,
  "scale": 0.4,
  "format": "jpeg",
  "bytes": 38112,
  "sha256": "…",
  "path": "/home/rivet/.rivet/screenshots/last.jpg",
  "captured_at": 0,
  "display_id": 0
}
```

`dest=raw` headers: `X-Rivet-Width`, `X-Rivet-Height`, `X-Rivet-Scale`.

**Rate limits:** 2/s and 30/min, plus one concurrent encode. Over limit → HTTP
**429** `error: rate_limited` with `retry_after_ms` and `Retry-After` (seconds).

**API level:** requires Android 11+ (API 30). Below that → **501** `unsupported`.

**After APK upgrade:** adding screenshot capability often requires **toggling Rivet
Accessibility off/on** (or re-enable) before screenshots work. If you see
`no_accessibility_access` right after an upgrade, re-toggle a11y first.

Do **not** mesh-upload screenshots (`rivet-shared put` etc.). Prefer `dest=file`
and local multimodal attach; use base64 sparingly.

### GET `/ui`

```sh
curl -s -H "X-Rivet-Token: $TOKEN" 127.0.0.1:9876/ui
```

Flat list of nodes with `text`, `contentDescription`, `bounds`, `clickable`, etc.
No hierarchy, no stable `nodeId` yet (`capabilities.ui.node_id` is false until a
later PR). Prefer screenshot + tree together for Compose-heavy UIs.

### POST `/action`

```sh
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"click","x":540,"y":1200}' 127.0.0.1:9876/action
```

Action types:

| type | Body fields | Behavior |
|------|-------------|----------|
| `click` | `x`, `y` | Tap at pixel coordinates |
| `swipe` | `x1`, `y1`, `x2`, `y2`, `duration` (default 280) | Swipe / scroll |
| `text` | `text` | Type into the focused field (replaces contents) |
| `global` | `action`: `BACK` \| `HOME` \| `RECENTS` \| `NOTIFICATIONS` \| `QUICK_SETTINGS` | Global a11y action |
| `node_click` | `text`, optional `package` | Tap first node whose text/contentDescription contains substring (case-insensitive) |
| `launch` | `package` | Launch app by package name |
| `intent` | `action`, optional `data`, optional `package` | `startActivity` with intent |

Success body shape: `{"ok": <bool>, "executed_at": <ms>}`. Gesture `ok` means the
platform accepted the gesture for dispatch — not that the finger completed
(`capabilities.gesture_wait` is false until a later PR).

Blocked in `eyes` and `parked` (403 `forbidden_mode`).

### POST `/notify`

```sh
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Alert","body":"Details","url":"https://example.com"}' 127.0.0.1:9876/notify
```

Fields: `title` (required), `body` or `text`, optional `url`, optional `id` / `tag`
for notification id. Posts on the agent-alert channel. Allowed in all modes.

### POST `/exec` (DEBUG only)

```sh
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"cmd":["uname","-a"],"timeoutMs":20000}' 127.0.0.1:9876/exec
```

Body: `cmd` (argv array), optional `env`, `cwd`, `timeoutMs` (default 20000).
**Absent on release builds** (404). Treated like an action for modes (blocked in
eyes/parked).

---

## Errors

Canonical error JSON (HTTP status matches `code` unless noted):

```json
{
  "ok": false,
  "error": "unauthorized",
  "message": "missing or invalid X-Rivet-Token",
  "code": 401
}
```

Stable `error` strings:

| `error` | HTTP | Meaning |
|---------|------|---------|
| `unauthorized` | 401 | bad/missing token |
| `forbidden_mode` | 403 | control mode blocks this endpoint |
| `not_found` | 404 | unknown path |
| `bad_request` | 400 | malformed body/query |
| `rate_limited` | 429 | screenshot token-bucket limit (+ `retry_after_ms`) |
| `unsupported` | 501 | screenshot on API &lt; 30 |
| `a11y_disconnected` | 503 | accessibility service not bound |
| `no_accessibility_access` | 503 | platform denied screenshot access |
| `secure_window` | 200 / `ok:false` | secure flag blocks capture |
| `invalid_display` | 400 | bad display id |
| `interval_interval` | 429 | platform screenshot interval throttle |
| `timed_out` | 200 / `ok:false` | screenshot latch timeout |
| `internal_error` | 500 | unexpected failure |

Expected capture failures such as `secure_window` use HTTP **200** with
`ok:false` so agents can branch on JSON without treating them as transport errors.

---

## Driving the UI well (hard-won)

- Prefer **screenshot (`dest=file`) + `/ui`** for Compose-heavy screens.
- Most **Jetpack Compose** controls are unlabeled (merged semantics) → find
  `clickable` bounds, not text labels; confirm with a shot when unsure.
- The **soft keyboard reflows coordinates** every keystroke → fill one field, re-dump
  `/ui`, then continue; never batch taps on stale coordinates.
- Keyboard covering a button: one `BACK` often dismisses just the keyboard → re-dump
  → tap. Count `BACK`s — three in a row can leave the app into system UI.
- Tap dispatch is occasionally absorbed — retry once.
- This is a **personal phone**. Private things stay private; ask before outward-facing
  or hard-to-undo actions (messages, posts, irreversible device changes). Never upload
  screenshots off-device via mesh.
