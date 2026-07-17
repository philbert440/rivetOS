#!/usr/bin/env bash
# Dev-only harness: mock ControlServer + exercise every phone subcommand and exit codes.
# Usage: bash apps/rivet-android/overlay-src/rivet-phone/test/run.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PHONE_ROOT="$(cd "$HERE/.." && pwd)"
PHONE_MJS="$PHONE_ROOT/lib/phone.mjs"
MOCK_MJS="$HERE/mock-server.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node not found on PATH" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"; if [[ -n "${MOCK_PID:-}" ]] && kill -0 "$MOCK_PID" 2>/dev/null; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi' EXIT

export MOCK_PORT_FILE="$work/port"
export MOCK_PID_FILE="$work/pid"
export MOCK_TOKEN="test-token-$$"
export MOCK_SCREENSHOT_DIR="$work/screenshots"
export MOCK_MODE="full"
export MOCK_FORCE_ERROR=""
export MOCK_SCREENSHOT_SUPPORTED="true"
export MOCK_MODES_ENABLED="true"
export MOCK_WAIT_ENABLED="true"
export MOCK_CLIPBOARD_ENABLED="true"
export MOCK_NODE_ACTIONS_ENABLED="true"

node "$MOCK_MJS" &
MOCK_PID=$!

# Wait for port file
for _ in $(seq 1 50); do
  if [[ -f "$MOCK_PORT_FILE" ]]; then break; fi
  sleep 0.05
done
if [[ ! -f "$MOCK_PORT_FILE" ]]; then
  echo "FAIL: mock server did not publish port" >&2
  exit 1
fi
PORT="$(cat "$MOCK_PORT_FILE")"
export RIVET_CONTROL_JSON="$work/control.json"
printf '{"port":%s,"token":"%s"}\n' "$PORT" "$MOCK_TOKEN" > "$RIVET_CONTROL_JSON"

phone() {
  node "$PHONE_MJS" "$@"
}

PASS=0
FAIL=0
failures=()

assert_exit() {
  local want="$1"
  shift
  local label="$1"
  shift
  set +e
  out="$("$@" 2>"$work/err.txt")"
  code=$?
  set -e
  if [[ "$code" -eq "$want" ]]; then
    PASS=$((PASS + 1))
    echo "  PASS  exit=$code  $label"
  else
    FAIL=$((FAIL + 1))
    failures+=("$label (want exit $want got $code)")
    echo "  FAIL  exit=$code (want $want)  $label"
    echo "        stderr: $(head -c 200 "$work/err.txt" | tr '\n' ' ')"
    echo "        stdout: $(echo "$out" | head -c 200 | tr '\n' ' ')"
  fi
}

assert_exit_json_ok() {
  local label="$1"
  shift
  set +e
  out="$("$@" 2>"$work/err.txt")"
  code=$?
  set -e
  if [[ "$code" -eq 0 ]] && echo "$out" | grep -q '"ok": true'; then
    PASS=$((PASS + 1))
    echo "  PASS  exit=0 ok  $label"
  else
    FAIL=$((FAIL + 1))
    failures+=("$label (want ok exit 0)")
    echo "  FAIL  exit=$code  $label"
    echo "        stderr: $(head -c 200 "$work/err.txt" | tr '\n' ' ')"
    echo "        stdout: $(echo "$out" | head -c 200 | tr '\n' ' ')"
  fi
}

echo "=== phone CLI harness (mock 127.0.0.1:$PORT) ==="

# ── MVP + PR6b subcommands ───────────────────────────────────────────────────
assert_exit_json_ok "status" phone status
assert_exit_json_ok "mode full" phone mode full
assert_exit_json_ok "mode eyes" phone mode eyes
# restore full for actuation tests
assert_exit_json_ok "mode full (restore)" phone mode full
assert_exit_json_ok "ui default" phone ui
assert_exit_json_ok "ui compact" phone ui --format compact
assert_exit_json_ok "ui filters" phone ui --format compact --clickable --text Settings --limit 5
assert_exit_json_ok "shot dest=file" phone shot --dest file
assert_exit_json_ok "shot -o copy" phone shot -o "$work/copy.jpg"
if [[ -f "$work/copy.jpg" ]]; then
  PASS=$((PASS + 1))
  echo "  PASS  shot -o produced file"
else
  FAIL=$((FAIL + 1))
  failures+=("shot -o missing file")
  echo "  FAIL  shot -o did not create $work/copy.jpg"
fi
assert_exit_json_ok "shot dest=json" phone shot --dest json
assert_exit_json_ok "tap" phone tap 100 200
assert_exit_json_ok "swipe" phone swipe 100 800 100 200 --duration 200
assert_exit_json_ok "text" phone text 'hello'
assert_exit_json_ok "text --append" phone text --append 'more'
assert_exit_json_ok "global BACK" phone global BACK
assert_exit_json_ok "global HOME" phone global HOME
assert_exit_json_ok "click-text" phone click-text 'Settings'
assert_exit_json_ok "click-text package" phone click-text 'Settings' --package com.android.settings
assert_exit_json_ok "node click" phone node n1
assert_exit_json_ok "node long_click" phone node n1 --action long_click
assert_exit_json_ok "node set_text" phone node n2 --action set_text --text 'typed'
assert_exit_json_ok "node focus" phone node n2 --action focus
assert_exit_json_ok "node scroll_forward" phone node n0 --action scroll_forward
assert_exit_json_ok "long-press coords" phone long-press 100 200 --duration 500
assert_exit_json_ok "long-press --node" phone long-press --node n1
assert_exit_json_ok "double-tap" phone double-tap 100 200
assert_exit_json_ok "drag" phone drag 10 20 300 400 --duration 250
assert_exit_json_ok "scroll down" phone scroll down
assert_exit_json_ok "scroll up --node" phone scroll up --node n0
assert_exit_json_ok "wait --text" phone wait --text Settings
assert_exit_json_ok "wait --package" phone wait --package com.android.settings --timeout 5000
assert_exit_json_ok "clipboard get" phone clipboard get
assert_exit_json_ok "clipboard set" phone clipboard set 'hello clip'
assert_exit_json_ok "launch" phone launch com.android.settings
assert_exit_json_ok "intent" phone intent --action VIEW --data 'https://example.com'
assert_exit_json_ok "notify" phone notify --title 'Test' --body 'Body' --url 'https://example.com'
assert_exit 0 "help" phone help

# ── Exit code paths ──────────────────────────────────────────────────────────
echo "--- exit-code paths ---"

# usage → 2
assert_exit 2 "usage: no args" phone
assert_exit 2 "usage: tap missing args" phone tap
assert_exit 2 "usage: bad global" phone global NOPE
assert_exit 2 "usage: wait no condition" phone wait
assert_exit 2 "usage: clipboard bad op" phone clipboard
assert_exit 2 "usage: set_text missing --text" phone node n1 --action set_text
assert_exit 2 "usage: long-press missing coords" phone long-press
assert_exit 2 "usage: scroll bad dir" phone scroll diagonal
assert_exit 2 "unknown subcommand" phone frobnicate

# mode forbidden on action → 1
assert_exit_json_ok "mode eyes for 403" phone mode eyes
assert_exit 1 "action blocked in eyes" phone tap 1 2
assert_exit_json_ok "mode parked" phone mode parked
assert_exit 1 "ui blocked in parked" phone ui
assert_exit_json_ok "mode full again" phone mode full

# stale_node → 1
assert_exit 1 "stale_node" phone node n_stale

# busy → 3 (set via mock admin endpoint, then clear)
mock_force() {
  local err_val="$1"
  PORT="$PORT" MOCK_TOKEN="$MOCK_TOKEN" node -e "
const http=require('http');
const body=JSON.stringify({error:process.argv[1]});
const req=http.request({host:'127.0.0.1',port:process.env.PORT,path:'/_mock/force',method:'POST',
  headers:{'X-Rivet-Token':process.env.MOCK_TOKEN,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},
  res=>{res.resume(); res.on('end',()=>process.exit(0));});
req.write(body); req.end();
" "$err_val"
}
mock_force "busy"
assert_exit 3 "busy → exit 3" phone tap 1 2
mock_force "none"

# wait timeout path (secondary mock with MOCK_WAIT_MATCH=false)
WAIT_PORT_FILE="$work/port-wait-to"
MOCK_PORT_FILE="$WAIT_PORT_FILE" MOCK_PID_FILE="$work/pid-wait-to" \
  MOCK_TOKEN="$MOCK_TOKEN" MOCK_WAIT_MATCH="false" \
  node "$MOCK_MJS" &
WAIT_TO_PID=$!
for _ in $(seq 1 50); do
  if [[ -f "$WAIT_PORT_FILE" ]]; then break; fi
  sleep 0.05
done
WPORT="$(cat "$WAIT_PORT_FILE")"
printf '{"port":%s,"token":"%s"}\n' "$WPORT" "$MOCK_TOKEN" > "$work/control-wait-to.json"
assert_exit 1 "wait timed_out → exit 1" env RIVET_CONTROL_JSON="$work/control-wait-to.json" node "$PHONE_MJS" wait --text Never
kill "$WAIT_TO_PID" 2>/dev/null || true
wait "$WAIT_TO_PID" 2>/dev/null || true

# unauthorized → 1 (/status is unauthenticated; probe a token route)
bad_cfg="$work/bad-control.json"
printf '{"port":%s,"token":"wrong"}\n' "$PORT" > "$bad_cfg"
assert_exit 1 "unauthorized ui" env RIVET_CONTROL_JSON="$bad_cfg" node "$PHONE_MJS" ui

# connection refused → 1
printf '{"port":1,"token":"x"}\n' > "$work/dead.json"
assert_exit 1 "connection refused" env RIVET_CONTROL_JSON="$work/dead.json" node "$PHONE_MJS" status

# screenshot unsupported feature-detect → 1
# Restart mock with SHOT unsupported is heavy; spawn a second mock:
SHOT_PORT_FILE="$work/port2"
SHOT_PID_FILE="$work/pid2"
MOCK_PORT_FILE="$SHOT_PORT_FILE" MOCK_PID_FILE="$SHOT_PID_FILE" \
  MOCK_TOKEN="$MOCK_TOKEN" MOCK_SCREENSHOT_SUPPORTED="false" \
  MOCK_SCREENSHOT_DIR="$work/screenshots2" \
  node "$MOCK_MJS" &
SHOT_PID=$!
for _ in $(seq 1 50); do
  if [[ -f "$SHOT_PORT_FILE" ]]; then break; fi
  sleep 0.05
done
SPORT="$(cat "$SHOT_PORT_FILE")"
printf '{"port":%s,"token":"%s"}\n' "$SPORT" "$MOCK_TOKEN" > "$work/control-noshot.json"
assert_exit 1 "screenshot unsupported" env RIVET_CONTROL_JSON="$work/control-noshot.json" node "$PHONE_MJS" shot
kill "$SHOT_PID" 2>/dev/null || true
wait "$SHOT_PID" 2>/dev/null || true

# modes disabled feature-detect → 1
MODE_PORT_FILE="$work/port3"
MOCK_PORT_FILE="$MODE_PORT_FILE" MOCK_PID_FILE="$work/pid3" \
  MOCK_TOKEN="$MOCK_TOKEN" MOCK_MODES_ENABLED="false" \
  node "$MOCK_MJS" &
MODE_PID=$!
for _ in $(seq 1 50); do
  if [[ -f "$MODE_PORT_FILE" ]]; then break; fi
  sleep 0.05
done
MPORT="$(cat "$MODE_PORT_FILE")"
printf '{"port":%s,"token":"%s"}\n' "$MPORT" "$MOCK_TOKEN" > "$work/control-nomode.json"
assert_exit 1 "mode unsupported" env RIVET_CONTROL_JSON="$work/control-nomode.json" node "$PHONE_MJS" mode parked
kill "$MODE_PID" 2>/dev/null || true
wait "$MODE_PID" 2>/dev/null || true

# PR6b feature-detect-absent: wait/clipboard/node_actions false → exit 1
FEAT_PORT_FILE="$work/port4"
MOCK_PORT_FILE="$FEAT_PORT_FILE" MOCK_PID_FILE="$work/pid4" \
  MOCK_TOKEN="$MOCK_TOKEN" \
  MOCK_WAIT_ENABLED="false" \
  MOCK_CLIPBOARD_ENABLED="false" \
  MOCK_NODE_ACTIONS_ENABLED="false" \
  node "$MOCK_MJS" &
FEAT_PID=$!
for _ in $(seq 1 50); do
  if [[ -f "$FEAT_PORT_FILE" ]]; then break; fi
  sleep 0.05
done
FPORT="$(cat "$FEAT_PORT_FILE")"
printf '{"port":%s,"token":"%s"}\n' "$FPORT" "$MOCK_TOKEN" > "$work/control-nofeat.json"
assert_exit 1 "wait feature-detect absent" env RIVET_CONTROL_JSON="$work/control-nofeat.json" node "$PHONE_MJS" wait --text X
assert_exit 1 "clipboard feature-detect absent" env RIVET_CONTROL_JSON="$work/control-nofeat.json" node "$PHONE_MJS" clipboard get
assert_exit 1 "rich node feature-detect absent" env RIVET_CONTROL_JSON="$work/control-nofeat.json" node "$PHONE_MJS" node n1 --action long_click
# plain click still works without node_actions
assert_exit_json_ok "node click without node_actions cap" env RIVET_CONTROL_JSON="$work/control-nofeat.json" node "$PHONE_MJS" node n1
kill "$FEAT_PID" 2>/dev/null || true
wait "$FEAT_PID" 2>/dev/null || true

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== SUMMARY: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  echo "Failures:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "ALL PASS"
exit 0
