#!/usr/bin/env bash
# Produce the credential-free rootfs asset for the "friend" flavor.
#
#   scripts/sanitize-rootfs.sh [path-to-personal-rootfs.bin]
#       default input:  app/src/main/assets/rivet-rootfs.bin
#       output:         app/src/friend/assets/rivet-rootfs.bin
#
#   scripts/sanitize-rootfs.sh --patch-gs
#       add dev.rivet.app.friend{,.debug} client entries to app/google-services.json
#       (cloned from the dev.rivet.app entries) so the google-services plugin accepts
#       the .friend applicationId suffix.
#
# Runs on any Linux with GNU tar (the build host). Root not needed: the app
# extracts with busybox tar as a non-root uid, so ownership inside the tar is ignored —
# only paths and permission bits matter.
#
# Strategy for /home/rivet is WHITELIST, not blacklist: the entire home dir is dropped
# and rebuilt from shell dotfiles only. Everything the app needs there (rivet-bridge,
# ~/.rivet/control.json, ~/.ssh/authorized_keys, CLAUDE.md/GROK.md, claude trust config)
# is re-provisioned by RivetRuntime on first launch. The friend logs into Claude/Grok
# themselves via the in-app terminal.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/app/src/friend/assets/rivet-rootfs.bin"

if [[ "${1:-}" == "--patch-gs" ]]; then
    python3 - "$REPO_ROOT/app/google-services.json" <<'PY'
import json, sys, copy
path = sys.argv[1]
gs = json.load(open(path))
pkgs = {c["client_info"]["android_client_info"]["package_name"]: c for c in gs["client"]}
changed = False
for base in ("dev.rivet.app", "dev.rivet.app.debug"):
    friend = base.replace("dev.rivet.app", "dev.rivet.app.friend", 1)
    if base in pkgs and friend not in pkgs:
        c = copy.deepcopy(pkgs[base])
        c["client_info"]["android_client_info"]["package_name"] = friend
        gs["client"].append(c)
        changed = True
        print(f"added client entry: {friend}")
if changed:
    json.dump(gs, open(path, "w"), indent=2)
else:
    print("google-services.json already has friend entries")
PY
    exit 0
fi

IN="${1:-$REPO_ROOT/app/src/main/assets/rivet-rootfs.bin}"
[[ -f "$IN" ]] || { echo "input rootfs not found: $IN" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'chmod -R u+rwX "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT
echo "extracting $IN ..."
tar -xzf "$IN" -C "$WORK" --no-same-owner

echo "rebuilding /home/rivet from dotfiles + grok program only ..."
KEEP="$WORK/home-keep"
mkdir -p "$KEEP"
for f in .bashrc .profile .bash_logout; do
    [[ -f "$WORK/home/rivet/$f" ]] && cp -a "$WORK/home/rivet/$f" "$KEEP/"
done
# Keep the grok PROGRAM so a friend can `grok login` from the in-app terminal — grok installs
# under ~/.grok (not /usr/local), and /usr/local/bin/grok is a symlink into it. We stash it now
# and scrub credentials/personal state after the home rebuild (below) so nothing leaks.
if [[ -d "$WORK/home/rivet/.grok" ]]; then
    cp -a "$WORK/home/rivet/.grok" "$KEEP/.grok"
fi
chmod -R u+rwX "$WORK/home/rivet"
rm -rf "$WORK/home/rivet"
mkdir -p "$WORK/home/rivet"
cp -a "$KEEP"/. "$WORK/home/rivet/" 2>/dev/null || true
rm -rf "$KEEP"
# Scrub grok credentials, sessions, hooks and personal state — keep only the program
# (bin/bundled/vendor/docs/completions/version metadata). The friend authenticates fresh
# with `grok login`. The secret scan below is the backstop if anything credential-like remains.
if [[ -d "$WORK/home/rivet/.grok" ]]; then
    rm -rf "$WORK/home/rivet/.grok/"{auth.json,auth.json.lock,active_sessions.json,active_sessions.lock,agent_id,sessions,upload_queue,logs,models_cache.json,tip_cursor.json,config.toml,hooks,skills}
fi
chmod 700 "$WORK/home/rivet"

echo "stripping host keys, caches, logs ..."
rm -rf "$WORK/etc/dropbear" \
       "$WORK/root" "$WORK/tmp" "$WORK/var/tmp" \
       "$WORK/var/log" "$WORK/var/cache/apt" "$WORK/var/lib/apt/lists" \
       "$WORK/usr/local/etc/npmrc" "$WORK/etc/wireguard" 2>/dev/null || true
mkdir -p "$WORK/root" "$WORK/tmp" "$WORK/var/tmp" "$WORK/var/log"
chmod 700 "$WORK/root"; chmod 1777 "$WORK/tmp" "$WORK/var/tmp"

echo "scanning for residual secrets (text files only) ..."
# Note: bare prefixes ("sk-ant-") and doc-style placeholder URLs ("postgres://user:password@...")
# appear in bundled libraries (pg, key-detection logic) — require real-looking key bodies, and
# drop lines whose only postgres:// creds are obvious placeholders.
HITS="$(grep -rIoE \
    'sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xai-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|ya29\.[A-Za-z0-9._-]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|postgres(ql)?://[^ "'"'"'/@]+:[^ "'"'"'@]+@[^ "'"'"']+' \
    "$WORK" 2>/dev/null \
    | grep -vE '^[^:]*/(usr/(share|lib)|usr/local/lib/node_modules)/' \
    | cut -d: -f2- \
    | grep -vE 'postgres(ql)?://[^:]+:(password|pass|secret|\$\{?[A-Za-z_]+|%s|<[^>]+>|\*+)@' | sort -u || true)"
if [[ -n "$HITS" ]]; then
    echo "SECRET SCAN FAILED — credential-looking strings remain:" >&2
    echo "$HITS" | cut -c1-40 >&2
    echo "--- in files (relative to rootfs):" >&2
    while IFS= read -r pat; do
        grep -rIlF "$pat" "$WORK" 2>/dev/null | sed "s|^$WORK||" | head -5
    done <<< "$(echo "$HITS" | cut -c1-40)" | sort -u >&2
    exit 1
fi

echo "repacking ..."
mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$WORK" --owner=1000 --group=1000 .
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
echo
echo "next: gradlew :app:assembleFriendDebug"
