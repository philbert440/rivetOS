#!/usr/bin/env bash
# rivet-memory-offline.sh — durable offline outbox for RivetOS captures.
#
# Sourced by the claude + grok hook launchers. The bundled capture's spool is EPHEMERAL: its
# detached worker deletes the spool file even when the PG write fails, so a capture made while
# datahub is unreachable (a dead zone, airplane mode, VPN not yet up) is silently LOST. This
# persists every payload to a durable outbox and replays the backlog — idempotent by
# session_key, so re-sends are safe — once PG is reachable again. Best-effort and fully
# detached: the drain runs in the background so it never blocks or fails a session.

# True iff a TCP connect to the datahub PG endpoint (parsed from RIVETOS_PG_URL) succeeds.
_rivet_pg_reachable() {
  local u="${RIVETOS_PG_URL:-}"; [ -n "$u" ] || return 1
  local hp="${u#*@}"; hp="${hp%%/*}"; hp="${hp%%\?*}"   # strip creds / db / query -> host:port
  local host="${hp%%:*}" port="${hp##*:}"
  [ "$host" = "$port" ] && port=5432                    # no explicit port
  [ -n "$host" ] || return 1
  timeout 2 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null
}

# Replay every queued payload in <box> through its stored argv (idempotent), once PG is up.
# Each entry is two files: <id>.cmd (argv, one token per line) + <id>.in (the stdin payload).
_rivet_drain() {
  local box="$1"
  _rivet_pg_reachable || return 0
  local c base line n=0
  for c in "$box"/*.cmd; do
    [ -e "$c" ] || continue
    [ "$n" -ge 50 ] && break                            # cap a post-outage herd; rest drains next fire
    n=$((n + 1))
    base="${c%.cmd}"
    if [ ! -e "$base.in" ]; then rm -f "$c"; continue; fi
    local argv=()
    while IFS= read -r line; do argv+=("$line"); done < "$c"
    [ "${#argv[@]}" -ge 1 ] || { rm -f "$c" "$base.in"; continue; }
    # PG was just reachable; the capture front-end hands off to its own worker and exits 0.
    if "${argv[@]}" < "$base.in" >/dev/null 2>&1; then rm -f "$c" "$base.in"; fi
  done
}

# rivet_offline_run <outbox_dir> <cmd...>   — payload arrives on stdin.
# Persists the payload + argv durably, then kicks a detached drain (replays the backlog,
# including this one, when PG is reachable). Returns immediately; never blocks the hook.
rivet_offline_run() {
  local box="$1"; shift
  if ! mkdir -p "$box" 2>/dev/null; then "$@"; return 0; fi   # fallback: original behaviour
  local id="$(date +%s)-$$-${RANDOM}"
  if ! cat > "$box/$id.in" 2>/dev/null; then "$@" < "$box/$id.in" 2>/dev/null || true; return 0; fi
  : > "$box/$id.cmd"
  local a; for a in "$@"; do printf '%s\n' "$a" >> "$box/$id.cmd"; done
  ( _rivet_drain "$box" ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
  return 0
}
