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
| GET | `/ui` | token | A11y dump (`format=flat|tree|compact` + filters) with **nodeId**; blocked when `parked` |
| GET | `/screenshot` | token | Scaled JPEG; default `dest=file` → `~/.rivet/screenshots/last.jpg` |
| POST | `/action` | token | click, swipe, long_press, double_tap, drag, scroll, text, global, node_click, **node_action**, clipboard, launch, intent; `full` only |
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

**capabilities.ui:** `node_id: true`, `formats: ["flat","tree","compact"]`, `filters: true`.

**capabilities (rich actions):** `clipboard: true`; `node_actions: ["click","long_click","focus","set_text","scroll_forward","scroll_backward","select"]`; nested `actions.gestures` / `actions.text_modes` / `actions.clipboard_ops` for feature-detect.

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

# Agent-preferred compact view (server default remains flat)
curl -s -H "X-Rivet-Token: $TOKEN" \
  '127.0.0.1:9876/ui?format=compact'

# Tree + filters example
curl -s -H "X-Rivet-Token: $TOKEN" \
  '127.0.0.1:9876/ui?format=tree&clickable=1&limit=50'
```

| Query | Default | Description |
|-------|---------|-------------|
| `format` | `flat` | `flat` \| `tree` \| `compact` (unknown → **400** `bad_request`) |
| `maxDepth` | `12` | Depth cap (root depth = 0) |
| `bounds` | `1` | Include bounds objects when `1` |
| `limit` | `0` | Max **emitted** nodes after filters; **0** = no emit limit. Walk always hard-capped at **500** |
| `fields` | (all) | Comma-separated field allowlist; **`id` always kept** |
| `clickable` | | `1` / `true` → emit only clickable nodes |
| `editable` | | `1` / `true` → emit only editable nodes |
| `text` | | Case-insensitive **contains** on `text` or `contentDescription` |
| `textExact` | | Exact match on `text` or `contentDescription` |
| `textRegex` | | Regex `find` on `text` or `contentDescription`; **max length 64**; invalid / too long → **400** `bad_request` |
| `viewId` | | Case-insensitive **contains** on `viewId` |
| `package` | | **Equals** package name |
| `class` | | Case-insensitive **contains** on class name |
| `visible` | `1` | When `1`, drop nodes with `visible=false` from emission |

**Formats** (same DFS ids from a single walk; `NodeIndex` always indexes the full hard-capped tree so `phone node nX` works even if the node was filtered out of the response):

| format | Shape | Notes |
|--------|-------|-------|
| `flat` (server default) | `nodes[]` flat list | Full walk (minus emission filters); compat |
| `tree` | nested `children[]` under each node | Hierarchy among **emitted** nodes (orphans reparented to nearest emitted ancestor) |
| `compact` | flat `nodes[]` of **interesting** nodes only | Interesting = clickable **or** editable **or** scrollable **or** non-empty text/contentDescription. **Agent-preferred** via skill; server default stays `flat` |

Filters and compact only affect **which nodes are emitted**. The underlying walk still builds ids `n0…nN` up to hard cap **500** and stores them in `NodeIndex`.

Each node may include:

| Field | Meaning |
|-------|---------|
| `id` | Ephemeral id for this dump: `n0` … `nN` (DFS order) — always present |
| `pid` | Parent id, or JSON `null` for the root |
| `depth` | Depth from root |
| `path` | Child-index path from root, e.g. `"0/2/1"` (empty string for root) |
| `class`, `text`, `contentDescription`, `hint`, `viewId`, `package` | Labels / identity |
| flags | `clickable`, `editable`, `focusable`, `focused`, `scrollable`, `enabled`, `checked`, `selected`, `visible` |
| `bounds` | When `bounds=1` (and not stripped by `fields`) |
| `children` | Only in `format=tree` |

Top-level also: `format`, `truncated` (true if hard cap or emit `limit` cut nodes), `dumpId`,
`package`, `timestamp`.

**Hard cap:** at most **500** nodes walked per dump (regardless of `limit` / filters). If the tree
is larger, `truncated: true` and later nodes are not indexed.

**nodeId lifetime (critical):**

- Ids are **per-dump only** (not stable across screens or time).
- Server keeps a `NodeIndex` for **15 seconds** after the dump (elapsedRealtime TTL).
- **Dump → act in the same turn.** Never cache `nodeId` across unrelated steps.
- After TTL expiry, UI change, or path/identity mismatch → `stale_node` — **re-dump `/ui`**
  and pick a fresh id.

Prefer screenshot + **`format=compact`** for agent loops on Compose-heavy UIs.

### POST `/action`

```sh
# Default: wait for gesture completion (click / swipe)
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"click","x":540,"y":1200}' 127.0.0.1:9876/action

# Fire-and-forget (accepted only; no completion wait)
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"click","x":540,"y":1200,"wait":false}' 127.0.0.1:9876/action

# Node-targeted click (preferred over coordinate hunting when you have an id)
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"node_action","nodeId":"n17","action":"click"}' 127.0.0.1:9876/action

# Long-press (coordinates or nodeId)
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"long_press","x":540,"y":1200}' 127.0.0.1:9876/action
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"long_press","nodeId":"n17"}' 127.0.0.1:9876/action

# Clipboard
curl -s -H "X-Rivet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"clipboard","op":"get"}' 127.0.0.1:9876/action
```

Common body fields (gestures):

| Field | Default | Description |
|-------|---------|-------------|
| `wait` | **`true`** | `true` → wait for `GestureResultCallback` completion/cancel; `false` → fire-and-forget |
| `timeoutMs` | `3000` | Total budget for queue wait + gesture latch; **capped at 10000** |

Action types:

| type | Body fields | Behavior |
|------|-------------|----------|
| `click` | `x`, `y`, optional `wait`, `timeoutMs` | Tap at pixel coordinates |
| `swipe` | `x1`, `y1`, `x2`, `y2`, `duration` (default 280), optional `wait`, `timeoutMs` | Swipe |
| `long_press` | `x`,`y` **or** `nodeId`; optional `durationMs` / `duration` (≥600 on coords); `wait`, `timeoutMs` | See long_press policy below |
| `double_tap` | `x`, `y`, optional `wait`, `timeoutMs` | Two short strokes at the same point |
| `drag` | `x1`, `y1`, `x2`, `y2`, optional `durationMs` (default 300), `wait`, `timeoutMs` | Single stroke drag |
| `scroll` | `direction` (`up`\|`down`\|`left`\|`right`), optional `nodeId`, optional `durationMs`, `wait`, `timeoutMs` | Prefer `ACTION_SCROLL_*` on node; else coordinate swipe |
| `text` | `text`, optional `mode` (`replace`\|`append`, default **replace**) | SET_TEXT on focused/first editable field |
| `global` | `action`: `BACK` \| `HOME` \| `RECENTS` \| `NOTIFICATIONS` \| `QUICK_SETTINGS` | Global a11y action |
| `node_click` | `text`, optional `package` | Tap first node whose text/contentDescription contains substring (case-insensitive) |
| **`node_action`** | **`nodeId`**, **`action`**, optional **`text`** (for `set_text`) | Re-resolve + `performAction` (see below) |
| `clipboard` | `op`: `get`\|`set`; `text` required for `set` | Read/write system clipboard (no a11y required) |
| `launch` | `package` | Launch app by package name |
| `intent` | `action`, optional `data`, optional `package` | `startActivity` with intent |

#### `long_press` policy (node vs stroke)

| Input | Behavior |
|-------|----------|
| **`nodeId` present** (non-empty) | Resolve node → prefer `ACTION_LONG_CLICK`. If that returns false and bounds are usable → center-point long-press **stroke ≥ 600 ms** via the waited gesture path. Response `type` is `long_press` (with `nodeId` + `action: long_click`). |
| **Coordinates only** (`x`, `y`) | Single stroke hold, duration **≥ 600 ms** (request `durationMs`/`duration` clamped up to min 600). PR2 gesture envelope. |

Do not pass both when you mean node-targeted; `nodeId` wins if non-empty.

#### `scroll`

```json
{"type":"scroll","direction":"down"}
{"type":"scroll","direction":"down","nodeId":"n42"}
```

1. With `nodeId`: resolve; try directional `ACTION_SCROLL_UP/DOWN/LEFT/RIGHT`, then `ACTION_SCROLL_FORWARD/BACKWARD` (down/right → forward; up/left → backward).
2. If performAction fails: swipe inside node bounds (finger opposite content motion).
3. Without `nodeId`: swipe near screen center. Gesture path returns the PR2 envelope (`type: scroll`); successful performAction returns `{ok, type:scroll, nodeId, action:scroll_<dir>, completed, durationMs, …}`.

#### `text` modes

```json
{"type":"text","text":"hello"}
{"type":"text","mode":"append","text":" world"}
```

| `mode` | Behavior |
|--------|----------|
| `replace` (default) | `ACTION_SET_TEXT` with `text` only |
| `append` | Read current field text, SET_TEXT with `current + text` |

Unknown `mode` → **400** `bad_request`.

#### `clipboard`

```json
{"type":"clipboard","op":"get"}
{"type":"clipboard","op":"set","text":"copied"}
```

- **get** → `{ok:true, type:clipboard, op:get, text:"…", executed_at}`
- **set** → `{ok:true, type:clipboard, op:set, executed_at}` (`text` required)
- Does **not** require accessibility; does **not** take the gesture lock. Still mode-gated (`full` only).

#### `node_action` (rich)

```json
{"type":"node_action","nodeId":"n17","action":"click"}
{"type":"node_action","nodeId":"n3","action":"set_text","text":"hello"}
{"type":"node_action","nodeId":"n9","action":"long_click"}
{"type":"node_action","nodeId":"n12","action":"scroll_forward"}
```

| Field | Required | Notes |
|-------|----------|--------|
| `type` | yes | `node_action` |
| `nodeId` | yes | From the **latest** `/ui` dump within TTL |
| `action` | yes | `click` \| `long_click` \| `focus` \| `set_text` \| `scroll_forward` \| `scroll_backward` \| `select` |
| `text` | for `set_text` | SET_TEXT argument |

Unknown `action` → **400** `bad_request`.

**CLI mapping (future `phone` CLI):**

```text
phone node n17
  → POST /action {"type":"node_action","nodeId":"n17","action":"click"}
```

**Server behavior:**

1. Mode gate (blocked in eyes/parked → 403 `forbidden_mode`).
2. Resolve `nodeId` against the last dump’s index (15s TTL, path walk + identity).
3. On resolve failure: **`stale_node`** (HTTP **400**) or **`a11y_disconnected`** (HTTP **503**).
4. On success: `performAction` for the mapped `ACTION_*`. For **`click`** / **`long_click`**, if performAction returns false and the node has bounds → center-point gesture (tap / ≥600 ms long-press) via the waited gesture path.
5. Success envelope:

```json
{
  "ok": true,
  "type": "node_action",
  "nodeId": "n17",
  "action": "click",
  "completed": true,
  "accepted": true,
  "cancelled": false,
  "timedOut": false,
  "durationMs": 8,
  "executed_at": 0
}
```

**`stale_node` recovery:** re-call `GET /ui`, read a fresh `id`, act immediately — do not retry
the old id.

**Gesture envelope** (`click` / `swipe` / `long_press` coords / `double_tap` / `drag` / `scroll` swipe) — `capabilities.gesture_wait` is **true**:

```json
{
  "ok": true,
  "accepted": true,
  "completed": true,
  "cancelled": false,
  "timedOut": false,
  "type": "click",
  "durationMs": 72,
  "executed_at": 0
}
```

| Field | Meaning |
|-------|---------|
| `accepted` | Platform accepted the gesture for dispatch |
| `completed` | `onCompleted` fired (finger finished) |
| `cancelled` | `onCancelled` — user touch interrupt or system cancel |
| `timedOut` | Latch expired before completed/cancelled |
| `ok` | When `wait:true` → **`ok` ≡ `completed`**. When `wait:false` → **`ok` ≡ `accepted`**. |

**Completed vs cancelled:** `cancelled:true` means another touch or the system aborted the gesture.
Retry **once**, or re-dump `/ui` / screenshot and re-plan — do not hammer the same coordinates.

**Busy (queue full):** waited gestures serialize through a single-flight lock (FIFO). If more
than **4** callers are already waiting, the new request is rejected immediately:

- HTTP **429**, `error: busy`, `message: gesture_busy` (body `code: 429`)
- This is **not** `rate_limited` (that string is reserved for token-bucket limits on
  screenshots / future request-rate limits)
- Guidance: brief backoff (e.g. 100–300 ms) and retry **once**

**Other gesture failures** still use HTTP **200** with `ok:false` so agents branch on JSON:

| Condition | HTTP | `error` | Flags |
|-----------|------|---------|--------|
| Cancelled | 200 | `action_failed` | `cancelled:true` |
| Timed out | 200 | `timed_out` | `timedOut:true` |
| Not accepted | 200 | `action_failed` | `accepted:false` |
| Queue full | **429** | `busy` | — |

**Non-gesture** types (`text`, `global`, `node_click`, `launch`, `intent`, `clipboard`, and
`node_action` / `scroll` when only `performAction` runs) keep a simpler or node envelope and
do **not** take the gesture lock.

**`node_action`** uses the richer envelope above (`nodeId`, `action`, `completed` /
`durationMs`). Click / long_click **fallback** may take the gesture lock (and can return `busy`).

**Gesture types** that always use the single-flight queue when waited: `click`, `swipe`,
`long_press` (coords), `double_tap`, `drag`, and `scroll` swipe fallback.

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
| `stale_node` | 400 | nodeId expired or re-resolve failed — re-dump `/ui` |
| `rate_limited` | 429 | screenshot token-bucket limit (+ `retry_after_ms`) — **not** gesture queue |
| `busy` | 429 | gesture single-flight queue full (`message: gesture_busy`) |
| `unsupported` | 501 | screenshot on API &lt; 30 |
| `a11y_disconnected` | 503 | accessibility service not bound |
| `no_accessibility_access` | 503 | platform denied screenshot access |
| `secure_window` | 200 / `ok:false` | secure flag blocks capture |
| `invalid_display` | 400 | bad display id |
| `interval_interval` | 429 | platform screenshot interval throttle |
| `timed_out` | 200 / `ok:false` | screenshot or gesture latch timeout |
| `action_failed` | 200 / `ok:false` | gesture cancelled / not accepted / non-gesture false |
| `internal_error` | 500 | unexpected failure |

Expected capture failures such as `secure_window` use HTTP **200** with
`ok:false` so agents can branch on JSON without treating them as transport errors.

---

## Driving the UI well (hard-won)

- Prefer **screenshot (`dest=file`) + `/ui`** for Compose-heavy screens.
- Prefer **`node_action`** (click / long_click / scroll_* / set_text / …) when you have a fresh
  `id` from the same-turn dump; fall back to coordinates only when needed.
- Use **`long_press` with `nodeId`** when possible (ACTION_LONG_CLICK); coordinate long_press
  holds ≥600 ms.
- **Never cache `nodeId`** across turns — 15s TTL and tree churn will yield `stale_node`.
- Most **Jetpack Compose** controls are unlabeled (merged semantics) → find
  `clickable` bounds / use nodeId re-resolve with bounds-center identity; confirm with a shot.
- The **soft keyboard reflows coordinates** every keystroke → fill one field, re-dump
  `/ui`, then continue; never batch taps on stale coordinates.
- Keyboard covering a button: one `BACK` often dismisses just the keyboard → re-dump
  → tap. Count `BACK`s — three in a row can leave the app into system UI.
- Gesture `ok` with default `wait:true` means **completed** — if `cancelled`, retry once
  or re-dump; if `busy` (429), brief backoff and retry once; if `timed_out`, re-shot/re-dump.
- This is a **personal phone**. Private things stay private; ask before outward-facing
  or hard-to-undo actions (messages, posts, irreversible device changes). Never upload
  screenshots off-device via mesh.
