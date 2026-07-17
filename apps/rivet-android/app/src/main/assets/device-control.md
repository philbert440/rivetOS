# RivetHub device control (v0.1)

Canonical on-device control API for agents in the proot rootfs.

**This file is rewritten on every RivetHub app launch** from the APK asset
(`device-control.md`). Do not rely on hand-edits surviving a relaunch.

Fidelity upgrades (screenshot, control modes, nodeId targeting, `phone` CLI) land
incrementally. **Feature-detect via `GET /status`** — do not assume endpoints from
older notes still missing or present.

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

## Endpoints (v0.1)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/status` | none | Health probe; package, a11y connected, WG status, `version` |
| GET | `/ui` | token | Flat a11y `nodes[]` (maxDepth 12) |
| POST | `/action` | token | click, swipe, text, global, node_click, launch, intent |
| POST | `/notify` | token | High-priority agent alert notification |
| POST | `/exec` | token | **DEBUG builds only** — arbitrary argv under app uid |

### GET `/status` (no token)

```sh
curl -s 127.0.0.1:9876/status
```

Useful fields: `ok`, `accessibility_connected`, `current_package`, `port`, `version`
(`"0.1.0"`), WireGuard status keys. If `accessibility_connected` is false, UI
read/act calls return **503** (`error: a11y_disconnected`) until the user enables
Rivet Accessibility in Android Settings.

### GET `/ui`

```sh
curl -s -H "X-Rivet-Token: $TOKEN" 127.0.0.1:9876/ui
```

Flat list of nodes with `text`, `contentDescription`, `bounds`, `clickable`, etc.
No hierarchy, no stable `nodeId` yet. Navigate by reading this tree, not pixels
(no screenshot endpoint in v0.1).

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
platform accepted the gesture for dispatch — not that the finger completed.

### POST `/notify`

```sh
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Alert","body":"Details","url":"https://example.com"}' 127.0.0.1:9876/notify
```

Fields: `title` (required), `body` or `text`, optional `url`, optional `id` / `tag`
for notification id. Posts on the agent-alert channel.

### POST `/exec` (DEBUG only)

```sh
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"cmd":["uname","-a"],"timeoutMs":20000}' 127.0.0.1:9876/exec
```

Body: `cmd` (argv array), optional `env`, `cwd`, `timeoutMs` (default 20000).
**Absent on release builds** (404).

---

## Errors

Canonical error JSON (HTTP status matches `code`):

```json
{
  "ok": false,
  "error": "unauthorized",
  "message": "missing or invalid X-Rivet-Token",
  "code": 401
}
```

Stable `error` strings used today: `unauthorized` (401), `not_found` (404),
`bad_request` (400), `a11y_disconnected` (503), `internal_error` (500).

---

## Driving the UI well (hard-won)

- **No screenshot endpoint yet** — use `/ui`, find `text`/`bounds`, tap the center.
- Most **Jetpack Compose** controls are unlabeled (merged semantics) → find
  `clickable` bounds, not text labels.
- The **soft keyboard reflows coordinates** every keystroke → fill one field, re-dump
  `/ui`, then continue; never batch taps on stale coordinates.
- Keyboard covering a button: one `BACK` often dismisses just the keyboard → re-dump
  → tap. Count `BACK`s — three in a row can leave the app into system UI.
- Tap dispatch is occasionally absorbed — retry once.
- This is a **personal phone**. Private things stay private; ask before outward-facing
  or hard-to-undo actions (messages, posts, irreversible device changes).
