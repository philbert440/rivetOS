#!/usr/bin/env bash
# Phase 0 MicBridge spike (rootless Path A).
# Installs a pw-record shim on PATH and creates the MicBridge FIFO.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
STATE="${RIVETOS_DEN_STATE_DIR:-$HOME/.rivetos/den}"
AUDIO_DIR="${RIVETOS_DEN_AUDIO_DIR:-$STATE/audio}"
FIFO="${RIVET_MIC_FIFO:-$AUDIO_DIR/mic.pcm}"
BIN_DIR="${RIVET_MIC_BIN_DIR:-$HOME/.local/bin}"

mkdir -p "$AUDIO_DIR" "$BIN_DIR"

if [[ ! -p "$FIFO" ]]; then
  rm -f "$FIFO"
  mkfifo "$FIFO"
  chmod 600 "$FIFO"
  echo "created FIFO $FIFO"
else
  echo "FIFO ok $FIFO"
fi

install -m 755 "$ROOT/pw-record" "$BIN_DIR/pw-record"
# Optional aliases Grok may probe after pw-record.
ln -sfn "$BIN_DIR/pw-record" "$BIN_DIR/parec" 2>/dev/null || true

# Keep a silent writer so open(O_RDONLY) never hangs tools that block on open.
# Background; safe to re-run.
if ! pgrep -f "rivet-mic-fifo-keeper:$FIFO" >/dev/null 2>&1; then
  # shellcheck disable=SC2094
  ( exec -a "rivet-mic-fifo-keeper:$FIFO" \
      dd if=/dev/zero bs=640 count=0 of="$FIFO" status=none 2>/dev/null & ) || true
  # Better keeper: open RDWR and sleep (does not burn CPU).
  nohup bash -c "
    exec -a 'rivet-mic-fifo-keeper:$FIFO' bash -c '
      exec 3<>\"$FIFO\"
      while true; do sleep 3600; done
    '
  " >/dev/null 2>&1 &
  echo "started FIFO keeper for $FIFO"
fi

cat <<EOF

MicBridge Phase 0 ready (Path A — shim recorder).

  FIFO:     $FIFO
  Recorder: $BIN_DIR/pw-record  (also linked as parec when possible)

Next:
  export PATH="$BIN_DIR:\$PATH"
  grok doctor
  # Voice section should find a recorder on PATH.

  # Optional live write test (silence):
  $ROOT/feed-silence.sh &
  timeout 1 pw-record --rate=16000 /tmp/rivet-mic-test.raw || true
  ls -la /tmp/rivet-mic-test.raw 2>/dev/null || true

EOF
