#!/usr/bin/env bash
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
export CURSOR_HOME="$TMP/cursor"
export KIT TMP
SETUP="$KIT/bin/setup-cursor-rivet-memory.sh"
mkdir -p "$CURSOR_HOME/plugins/local" "$CURSOR_HOME/skills" "$TMP/foreign"
printf 'user edited agent\n' > "$CURSOR_HOME/AGENT.md"
printf 'user edited memory\n' > "$CURSOR_HOME/MEMORY.md"
ln -s "$TMP/foreign" "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
mkdir "$CURSOR_HOME/skills/memory-stats"
printf keep > "$CURSOR_HOME/skills/memory-stats/SKILL.md"
python3 - <<'PY'
import json, os
from pathlib import Path
home, kit, tmp = map(Path, (os.environ['CURSOR_HOME'], os.environ['KIT'], os.environ['TMP']))
old = tmp / 'old checkout/integrations/cursor/rivet-memory'
(old / 'bin').mkdir(parents=True)
(old / 'skills/memory-recall').mkdir(parents=True)
for name in ['rivet-memory-hook.sh', 'rivet-memory-mcp.sh']:
    (old / 'bin' / name).touch()
(home / 'skills/memory-recall').symlink_to(old / 'skills/memory-recall')
(tmp / 'hook alias').symlink_to(kit / 'bin/rivet-memory-hook.sh')
(tmp / 'mcp alias').symlink_to(kit / 'bin/rivet-memory-mcp.sh')
hooks = [
    '/srv/other/bin/rivet-memory-hook.sh stop',
    f'/srv/other/bin/hook --note {kit}/bin/rivet-memory-hook.sh',
    f'"{kit}/bin/rivet-memory-hook.sh" stop',
    f'"{tmp}/hook alias" stop',
    f'"{old}/bin/rivet-memory-hook.sh" stop',
    './bin/rivet-memory-hook.sh stop',                       # relative: depends on runtime cwd, keep
    'rivet-memory-hook.sh stop',                              # bare: depends on runtime PATH, keep
    '/srv/personal/integrations/cursor/rivet-memory/bin/custom-hook.py',  # kit-like dir, foreign name, keep
]
(home / 'hooks.json').write_text(json.dumps({'version': 1, 'hooks': {
    'stop': [{'command': c} for c in hooks],
    'sessionStart': [{'command': '/srv/den/hook sessionStart'}],
}}))
servers = {
    'rivetos': {'command': '/srv/independent/server', 'env': {'NOTE': str(old / 'bin/rivet-memory-mcp.sh')}},
    'argument-only': {'command': '/srv/independent/server', 'args': [str(kit / 'bin/rivet-memory-mcp.sh')]},
    'direct': {'command': str(kit / 'bin/rivet-memory-mcp.sh')},
    'alias': {'command': str(tmp / 'mcp alias')},
    'old-shell': {'command': '/bin/bash', 'args': [str(old / 'bin/rivet-memory-mcp.sh')]},
    'bare-shell': {'command': 'bash', 'args': [str(kit / 'bin/rivet-memory-mcp.sh')], 'env': {'PATH': '/srv/independent/bin:/usr/bin'}},
    'system-shell': {'command': '/usr/bin/bash', 'args': [str(kit / 'bin/rivet-memory-mcp.sh')]},
    'wrapper': {'command': str(tmp / 'bash'), 'args': [str(kit / 'bin/rivet-memory-mcp.sh')]},
    'path-launcher': {'command': 'rivet-memory-mcp.sh', 'env': {'PATH': '/srv/independent/bin:/usr/bin'}},
}
(tmp / 'bash').touch()
(home / 'mcp.json').write_text(json.dumps({'mcpServers': servers}))
for name in ['hooks.json', 'mcp.json']:
    (home / name).chmod(0o640)
PY
cp "$CURSOR_HOME/hooks.json" "$TMP/hooks.before"
cp "$CURSOR_HOME/mcp.json" "$TMP/mcp.before"

# Dry run changes nothing.
bash "$SETUP" > "$TMP/dry.log" 2>&1
grep -q 'Leaving foreign plugin symlink alone' "$TMP/dry.log"
cmp "$CURSOR_HOME/hooks.json" "$TMP/hooks.before"
cmp "$CURSOR_HOME/mcp.json" "$TMP/mcp.before"
[ "$(cat "$CURSOR_HOME/AGENT.md")" = 'user edited agent' ]
[ ! -e "$CURSOR_HOME/agents" ]

bash "$SETUP" --apply > "$TMP/apply.log" 2>&1
python3 - <<'PY'
import json, os, shlex, stat
from pathlib import Path
home, kit = map(Path, (os.environ['CURSOR_HOME'], os.environ['KIT']))
hook = str(kit / 'bin/rivet-memory-hook.sh')
assert (home / 'plugins/local/rivet-memory-cursor').resolve() == Path(os.environ['TMP']) / 'foreign'
kit_events = json.loads((kit / 'hooks/hooks.json').read_text())['hooks']
hooks = json.loads((home / 'hooks.json').read_text())['hooks']
stop = [e['command'] for e in hooks['stop']]
assert stop == [
    '/srv/other/bin/rivet-memory-hook.sh stop',
    f'/srv/other/bin/hook --note {kit}/bin/rivet-memory-hook.sh',
    './bin/rivet-memory-hook.sh stop',
    'rivet-memory-hook.sh stop',
    '/srv/personal/integrations/cursor/rivet-memory/bin/custom-hook.py',
    f'{shlex.quote(hook)} stop',
], stop
assert hooks['sessionStart'] == [{'command': '/srv/den/hook sessionStart'}]
for ev in kit_events:
    ours = [e for e in hooks[ev] if e['command'].startswith(shlex.quote(hook))]
    assert len(ours) == 1 and ours[0]['command'] == f'{shlex.quote(hook)} {ev}', (ev, hooks[ev])
servers = json.loads((home / 'mcp.json').read_text())['mcpServers']
assert set(servers) == {'rivetos', 'argument-only', 'wrapper', 'path-launcher', 'bare-shell'}, set(servers)
assert servers['rivetos']['command'] == '/srv/independent/server'
for name in ['hooks.json', 'mcp.json']:
    assert stat.S_IMODE((home / name).stat().st_mode) == 0o640
    backups = list(home.glob(name + '.bak-*'))
    assert len(backups) == 1 and backups[0].read_bytes() == Path(os.environ['TMP'], name.split('.')[0] + '.before').read_bytes()
    assert stat.S_IMODE(backups[0].stat().st_mode) == 0o640
assert (home / 'skills/memory-recall').resolve() == kit / 'skills/memory-recall'
assert (home / 'skills/memory-today').resolve() == kit / 'skills/memory-today'
assert not (home / 'skills/memory-stats').is_symlink()
assert (home / 'skills/memory-stats/SKILL.md').read_text() == 'keep'
assert (home / 'agents/memory-researcher.md').resolve() == kit / 'agents/memory-researcher.md'
for name, content in [('AGENT.md', 'user edited agent\n'), ('MEMORY.md', 'user edited memory\n')]:
    backups = list(home.glob(name + '.bak-*'))
    assert len(backups) == 1 and backups[0].read_text() == content
    assert (home / name).read_bytes() == (kit / name).read_bytes()
PY
grep -q 'Skip rivetos server' "$TMP/apply.log"

# Rerun is a no-op.
cp "$CURSOR_HOME/hooks.json" "$TMP/hooks.after"
cp "$CURSOR_HOME/mcp.json" "$TMP/mcp.after"
bash "$SETUP" --apply > /dev/null
cmp "$CURSOR_HOME/hooks.json" "$TMP/hooks.after"
cmp "$CURSOR_HOME/mcp.json" "$TMP/mcp.after"
[ "$(find "$CURSOR_HOME" -name '*.bak-*' | wc -l)" -eq 4 ]

# Without a foreign rivetos entry the kit server is written; a kit plugin link is removed.
python3 - <<'PY'
import json, os
from pathlib import Path
home = Path(os.environ['CURSOR_HOME'])
p = home / 'mcp.json'
d = json.loads(p.read_text()); del d['mcpServers']['rivetos']; p.write_text(json.dumps(d))
PY
rm "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
ln -s "$KIT" "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
bash "$SETUP" --apply > /dev/null
[ ! -e "$CURSOR_HOME/plugins/local/rivet-memory-cursor" ]
python3 - <<'PY'
import json, os
from pathlib import Path
home, kit = map(Path, (os.environ['CURSOR_HOME'], os.environ['KIT']))
servers = json.loads((home / 'mcp.json').read_text())['mcpServers']
assert servers['rivetos'] == {'command': str(kit / 'bin/rivet-memory-mcp.sh')}, servers
PY

# An older checkout's unedited copies are replaced without another backup.
OLD="$TMP/old checkout/integrations/cursor/rivet-memory"
printf 'old kit agent\n' > "$OLD/AGENT.md"
printf 'old kit memory\n' > "$OLD/MEMORY.md"
cp "$OLD/AGENT.md" "$CURSOR_HOME/AGENT.md"
cp "$OLD/MEMORY.md" "$CURSOR_HOME/MEMORY.md"
ln -s "$OLD" "$CURSOR_HOME/plugins/local/rivet-memory-cursor"
bash "$SETUP" --apply > /dev/null
[ "$(find "$CURSOR_HOME" -name '*.bak-*' | wc -l)" -eq 5 ]

# Invalid JSON is refused, not overwritten.
printf '{not json' > "$CURSOR_HOME/hooks.json"
if bash "$SETUP" --apply > "$TMP/bad.log" 2>&1; then
  echo 'FAIL: invalid hooks.json overwritten' >&2; exit 1
fi
[ "$(cat "$CURSOR_HOME/hooks.json")" = '{not json' ]

# A fresh Cursor home gets 0600 config files.
FRESH="$TMP/fresh"
CURSOR_HOME="$FRESH" bash "$SETUP" --apply > /dev/null
[ "$(stat -c %a "$FRESH/hooks.json")" = 600 ]
[ "$(stat -c %a "$FRESH/mcp.json")" = 600 ]
echo 'PASS: setup global wiring, ownership, dry run, backups, modes, idempotence, and refusals'
