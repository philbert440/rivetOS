---
name: device-control
description: >
  Drive Phil's phone via the RivetHub accessibility control plane using the
  `phone` CLI (loopback ControlServer). Trigger phrases: phone control, tap
  the screen, take a screenshot, open Settings, swipe, type into a field,
  dump UI tree, click a node, device control, accessibility automation,
  parked/eyes mode, notify on phone. Prefer this skill over raw curl.
metadata:
  short-description: "phone CLI — see + drive this Android device"
---

# Device control (Fidelity MVP + PR6b)

You are on Phil's personal phone inside RivetHub proot. Control the screen with
the **`phone`** CLI (not hand-rolled curl unless debugging). Canonical docs:
**`~/.rivet/device-control.md`** (refreshed every app launch).

Config: `~/.rivet/control.json` → `{port, token}`. Base URL is always
`http://127.0.0.1:<port>` (loopback only). CLI sends `X-Rivet-Token` for you.

## Agent loop (default)

Do this in **one turn** when interacting with the UI:

1. **`phone shot`** — pixels for vision / verification (`~/.rivet/screenshots/last.jpg`).
2. **`phone ui --format compact`** — structured targets with stable-per-dump `id` fields (`n0`…`nN`).
3. **`phone node nX`** — click by nodeId (preferred over coordinate taps when an id exists).
4. **Verify** — `phone shot` and/or `phone ui --format compact` again.

```text
phone status
phone shot
phone ui --format compact --clickable
phone node n17
phone shot
```

### Critical rules

| Rule | Why |
|------|-----|
| **Dump → act in the SAME turn** | `nodeId` TTL is **15s**. Never cache ids across unrelated steps. |
| **`stale_node` → re-dump** | Tree changed or TTL expired. Fresh `phone ui`, pick a new id, act again. Do not guess. |
| **Keyboard reflow** | Soft keyboard moves every coordinate on each keystroke. After `phone text`, **re-dump** before the next tap/node click. Never batch taps on stale coords. |
| **Prefer nodeId over coords** | Compose often merges labels; compact ui + `phone node` is more reliable than hunting bounds. |
| **One BACK to dismiss keyboard** | Three BACKs can exit RivetHub into system Settings — count them. |

Coordinate fallback when needed: `phone tap X Y` using center of a node's `bounds`.
Text search fallback: `phone click-text 'Settings' [--package P]`.

### Wait (act → wait → verify)

After an action that should change the UI (launch, tap, intent), prefer
**`phone wait --text '…'`** (or `--package` / `--gone`) instead of blind sleeps
or busy-polling `phone ui`. Pattern: **act → wait → verify** with shot/ui.
Example: `phone launch com.android.settings` then `phone wait --package com.android.settings --timeout 8000`,
then `phone ui --format compact --clickable`. On timeout the CLI exits 1 with
`error:"timed_out"`. Feature-detect via `capabilities.wait` when present.

Clipboard (`phone clipboard get|set`), text append (`phone text --append`), rich
node actions (`phone node nX --action long_click|set_text|…`), and coordinate
gestures (`long-press`, `double-tap`, `drag`, `scroll`) are available on current
builds when the matching capability flag is true.

## Modes (kill switch)

| Mode | See UI | Screenshot | Actuate | Notify |
|------|--------|------------|---------|--------|
| `full` | ✓ | ✓ | ✓ | ✓ |
| `eyes` | ✓ | ✓ | **403** | ✓ |
| `parked` | **403** | **403** | **403** | ✓ |

```text
phone mode parked   # big red stop — no capture, no gestures
phone mode eyes     # observe only
phone mode full     # normal automation
```

- Check current mode: `phone status` → `"mode"`.
- If an action returns **403** / `error: "forbidden_mode"`: stop actuating. Tell Phil.
  Do not retry the same action in a loop. Switch mode only if Phil asked.
- Feature-detect: if `capabilities.modes` is missing, modes may not be on this build.

## Commands

```text
phone status
phone mode <full|eyes|parked>
phone ui [--format flat|tree|compact] [--clickable] [--editable] [--text S] [--package P] [--limit N]
phone shot [-o path] [--scale 0.4] [--quality 70] [--dest file|json]   # default dest=file
phone tap X Y
phone swipe X1 Y1 X2 Y2 [--duration 280]
phone text 'hello'                       # replace
phone text --append 'more'               # append into focused field
phone global BACK|HOME|RECENTS|NOTIFICATIONS|QUICK_SETTINGS
             |POWER_DIALOG|LOCK_SCREEN|TAKE_SCREENSHOT|DISMISS_NOTIFICATION_SHADE
phone click-text 'Settings' [--package P]
phone node NODE_ID [--action click|long_click|focus|set_text|
                    scroll_forward|scroll_backward|select] [--text S]
phone long-press X Y [--duration 600]
phone long-press --node NODE_ID
phone double-tap X Y
phone drag X1 Y1 X2 Y2 [--duration 300]
phone scroll <up|down|left|right> [--node NODE_ID]
phone wait [--text S] [--package P] [--gone S] [--timeout MS] [--interval MS]
phone clipboard get
phone clipboard set 'text'
phone launch PACKAGE
phone intent --action VIEW --data URL [--package P] [--confirm]
phone notify --title T [--body B] [--url U]
phone help
```

Global: `--timeout MS` (default 15000). Output is pretty JSON on stdout; one-line
summaries may appear on stderr.

## Exit codes

| Code | Meaning | Agent response |
|------|---------|----------------|
| **0** | Success (`ok:true` / 2xx) | Continue |
| **1** | Error: `ok:false`, HTTP 4xx/5xx, auth, mode gate, `stale_node`, connection refused, capability missing, wait timed_out | Read JSON `error`; for `stale_node` re-dump; for `forbidden_mode` stop; for connection refused ask Phil to enable accessibility |
| **2** | Usage error | Fix args |
| **3** | `error:"busy"` (gesture queue full) | Brief backoff (~200–500ms), **retry once**; if still busy, re-dump and reconsider |

## Privacy (non-negotiable)

1. **NEVER** `rivet-shared put` anything under `~/.rivet/screenshots/` (or any screenshot
   bytes/base64). Screenshots stay on-device. Mesh exfil is forbidden.
2. **Ask Phil before** SMS / share / payments / posting / anything outward-facing or hard
   to undo. The server's SafetyPolicy now returns `needs_confirm` for those intent surfaces;
   re-send with `phone intent … --confirm` **only after Phil approves** — the flag is your
   attestation that a human OK'd it, not a bypass to click past.
3. Do not log or paste full screenshot base64 into chat or memory unless Phil needs it.
4. Prefer `phone shot` → path (`last.jpg`) over `dest=json` base64.

## Surface status

The full command set above is **shipped** — wait, clipboard, text --append, rich node
actions, long-press, drag, double-tap, the expanded globals, and `intent --confirm` are
all live. Do not invent workarounds that pretend other surface exists; if a command isn't
listed above, it isn't there.

## Failure cheatsheet

| Symptom | Action |
|---------|--------|
| connection refused | Rivet accessibility off? Phil enables it in Android Settings. |
| 401 `unauthorized` | Stale token; relaunch agent session so `control.json` refreshes. |
| 403 `forbidden_mode` | Mode is eyes/parked; stop or ask Phil to `phone mode full`. |
| 400 `stale_node` | Re-run `phone ui`, new id, act same turn. |
| 429 `busy` | Exit 3 — backoff, retry once. |
| 429 `rate_limited` | Honor `retry_after_ms`; slow down shots. |
| 501 `unsupported` | Screenshot API &lt; 30 — use tree only. |
| `capabilities.screenshot.supported=false` | Same — tree-only navigation. |
| `capabilities.wait` / `clipboard` / `node_actions` false | Needs a newer RivetHub build for that feature. |
| Gesture `cancelled` / `timedOut` | Retry once or re-dump; user may have touched the screen. |
| wait `timed_out` | Re-dump UI; adjust condition or timeout; do not spin forever. |

## Examples

```sh
# Open Settings and tap a row by node id
phone launch com.android.settings
phone wait --package com.android.settings --timeout 8000
phone ui --format compact --clickable --text Network
phone node n12

# Type into focused field (then re-dump — keyboard reflow)
phone text 'hello@example.com'
phone ui --format compact --editable

# Append more text without wiping the field
phone text --append ' more'

# Long-press a node, then clipboard
phone long-press --node n3
phone clipboard get

# Observe-only while Phil demos
phone mode eyes
phone shot
phone ui --format compact
```
