#!/usr/bin/env bash
# Write silence into the MicBridge FIFO (s16le mono 16 kHz ≈ 640 B / 20 ms).
set -euo pipefail

STATE="${RIVETOS_DEN_STATE_DIR:-$HOME/.rivetos/den}"
AUDIO_DIR="${RIVETOS_DEN_AUDIO_DIR:-$STATE/audio}"
FIFO="${RIVET_MIC_FIFO:-$AUDIO_DIR/mic.pcm}"
RATE="${RIVET_MIC_RATE:-16000}"
# 20ms of s16le mono
BS=$(( RATE * 2 / 50 ))

if [[ ! -p "$FIFO" ]]; then
  echo "missing FIFO $FIFO — run setup.sh first" >&2
  exit 1
fi

echo "feeding silence → $FIFO (rate=$RATE, chunk=$BS bytes)  Ctrl+C to stop"
# O_RDWR open via bash so we don't block if no reader yet
exec 3<>"$FIFO"
while true; do
  dd if=/dev/zero bs="$BS" count=1 status=none >&3 || true
  sleep 0.02
done
