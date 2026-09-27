#!/usr/bin/env bash
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
export CURSOR_HOME="$TMP/cursor"
export KIT TMP
mkdir -p "$CURSOR_HOME/plugins/local" "$TMP/foreign"
printf 'user edited agent\n' > "$CURSOR_HOME/AGENT.md"
printf 'user edited memory\n' > "$CURSOR_HOME/MEMORY.md"
ln -s "$TMP/foreign" "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
python3 - <<'PY'
import json, os
from pathlib import Path
home, kit, tmp = map(Path, (os.environ['CURSOR_HOME'], os.environ['KIT'], os.environ['TMP']))
old = tmp / 'old checkout/integrations/cursor/rivet-memory'
(old / 'bin').mkdir(parents=True)
for name in ['rivet-memory-hook.sh', 'rivet-memory-mcp.sh']:
    (old / 'bin' / name).touch()
(tmp / 'hook alias').symlink_to(kit / 'bin/rivet-memory-hook.sh')
(tmp / 'mcp alias').symlink_to(kit / 'bin/rivet-memory-mcp.sh')
hooks = [
    '/srv/other/bin/rivet-memory-hook.sh stop',
    f'/srv/other/bin/hook --note {kit}/bin/rivet-memory-hook.sh',
    f'"{kit}/bin/rivet-memory-hook.sh" stop',
    f'"{tmp}/hook alias" stop',
    f'"{old}/bin/rivet-memory-hook.sh" stop',
    f'"{kit}/bin/rivet-memory-mcp.sh"',
]
(home / 'hooks.json').write_text(json.dumps({'hooks': {'stop': [{'command': c} for c in hooks]}}))
servers = {
    'rivetos': {'command': '/srv/independent/server', 'env': {'NOTE': str(old / 'bin/rivet-memory-mcp.sh')}},
    'argument-only': {'command': '/srv/independent/server', 'args': [str(kit / 'bin/rivet-memory-mcp.sh')]},
    'direct': {'command': str(kit / 'bin/rivet-memory-mcp.sh')},
    'alias': {'command': str(tmp / 'mcp alias')},
    'old-shell': {'command': '/bin/bash', 'args': [str(old / 'bin/rivet-memory-mcp.sh')]},
}
(home / 'mcp.json').write_text(json.dumps({'mcpServers': servers}))
for name in ['hooks.json', 'mcp.json']:
    (home / name).chmod(0o600)
PY
cp "$CURSOR_HOME/hooks.json" "$TMP/hooks.before"
cp "$CURSOR_HOME/mcp.json" "$TMP/mcp.before"
bash "$KIT/bin/setup-cursor-rivet-memory.sh" > "$TMP/dry.log" 2>&1
grep -Eq 'Refusing.*foreign' "$TMP/dry.log"
if bash "$KIT/bin/setup-cursor-rivet-memory.sh" --apply > "$TMP/refused.log" 2>&1; then
  echo 'FAIL: foreign symlink accepted' >&2; exit 1
fi
[ "$(readlink "$CURSOR_HOME/plugins/local/rivet-memory-cursor")" = "$TMP/foreign" ]
cmp "$CURSOR_HOME/hooks.json" "$TMP/hooks.before"
cmp "$CURSOR_HOME/mcp.json" "$TMP/mcp.before"
[ "$(cat "$CURSOR_HOME/AGENT.md")" = 'user edited agent' ]
rm "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
mkdir "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
printf keep > "$CURSOR_HOME/plugins/local/rivet-memory-cursor/keep"
if bash "$KIT/bin/setup-cursor-rivet-memory.sh" --apply > "$TMP/directory.log" 2>&1; then
  echo 'FAIL: real directory accepted' >&2; exit 1
fi
[ "$(cat "$CURSOR_HOME/plugins/local/rivet-memory-cursor/keep")" = keep ]
rm "$CURSOR_HOME/plugins/local/rivet-memory-cursor/keep"
rmdir "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
# Dry run must preserve even recognized legacy configuration and user edits.
bash "$KIT/bin/setup-cursor-rivet-memory.sh"
cmp "$CURSOR_HOME/hooks.json" "$TMP/hooks.before"
cmp "$CURSOR_HOME/mcp.json" "$TMP/mcp.before"
[ ! -e "$CURSOR_HOME/plugins/local/rivet-memory-cursor" ]
bash "$KIT/bin/setup-cursor-rivet-memory.sh" --apply
python3 - <<'PY'
import json, os, stat
from pathlib import Path
home, kit = map(Path, (os.environ['CURSOR_HOME'], os.environ['KIT']))
assert (home / 'plugins/local/rivet-memory-cursor').resolve() == kit
hooks = json.loads((home / 'hooks.json').read_text())['hooks']['stop']
assert len(hooks) == 2 and all(e['command'].startswith('/srv/other/') for e in hooks)
servers = json.loads((home / 'mcp.json').read_text())['mcpServers']
assert set(servers) == {'rivetos', 'argument-only'}
for name in ['hooks.json', 'mcp.json']:
    assert stat.S_IMODE((home / name).stat().st_mode) == 0o600
for name, content in [('AGENT.md', 'user edited agent\n'), ('MEMORY.md', 'user edited memory\n')]:
    backups = list(home.glob(name + '.bak-*'))
    assert len(backups) == 1 and backups[0].read_text() == content
    assert (home / name).read_bytes() == (kit / name).read_bytes()
PY
bash "$KIT/bin/setup-cursor-rivet-memory.sh" --apply
[ "$(find "$CURSOR_HOME" -name '*.bak-*' | wc -l)" -eq 2 ]
# An older checkout's unedited copies can be replaced without another backup.
OLD="$TMP/old checkout/integrations/cursor/rivet-memory"
printf 'old kit agent\n' > "$OLD/AGENT.md"
printf 'old kit memory\n' > "$OLD/MEMORY.md"
cp "$OLD/AGENT.md" "$CURSOR_HOME/AGENT.md"
cp "$OLD/MEMORY.md" "$CURSOR_HOME/MEMORY.md"
rm "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
ln -s "$OLD" "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
bash "$KIT/bin/setup-cursor-rivet-memory.sh" --apply
[ "$(find "$CURSOR_HOME" -name '*.bak-*' | wc -l)" -eq 2 ]
echo 'PASS: setup ownership, dry run, refusal, backups, modes, and idempotence'
