"""Offline regression checks for private bounded capture and the Cursor den adapter."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
HOOK = ROOT / 'integrations/cursor/rivet-memory/bin/rivet-memory-hook.sh'
with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp)
    home = base / 'home'
    home.mkdir()
    env = {**os.environ, 'HOME': str(home), 'RIVETOS_ENV_FILE': str(base / 'missing'),
           'RIVETOS_ROOT': str(base / 'missing')}
    spool = home / '.rivetos/cursor-capture/spool'

    count = 0
    def capture(payload=None):
        global count
        count += 1
        subprocess.run(['bash', str(HOOK), 'stop'], input=payload or json.dumps({'text': 'private', 'n': count}),
                       text=True, env=env, check=True)

    # The same event + payload twice (Cursor loading ~/.cursor/hooks.json as user and project
    # hooks) is spooled once; another event or payload is not a duplicate.
    dup_home = base / 'dup'
    dup_env = {**env, 'HOME': str(dup_home)}
    for ev, body in [('stop', '{"generation_id":"g1"}')] * 2 + [('stop', '{"generation_id":"g2"}'),
                                                              ('sessionEnd', '{"generation_id":"g1"}')]:
        subprocess.run(['bash', str(HOOK), ev], input=body, text=True, env=dup_env, check=True)
    assert len(list((dup_home / '.rivetos/cursor-capture/spool').glob('*.json'))) == 3

    capture()
    assert stat.S_IMODE(spool.stat().st_mode) == 0o700
    payload = next(spool.glob('*.json'))
    assert stat.S_IMODE(payload.stat().st_mode) == 0o600
    assert json.loads(payload.read_text())['payload'] == {'text': 'private', 'n': 1}
    log = home / '.rivetos/cursor-capture.log'
    assert 'spooled ' in log.read_text() and '(not yet ingested' in log.read_text()
    for i in range(505):
        p = spool / f'old-{i}.json'
        p.write_text('{}')
        os.utime(p, (i + 1, i + 1))
    capture()
    assert len(list(spool.glob('*.json'))) == 500
    assert not (spool / 'old-0.json').exists()
    big = spool / 'old-large.json'
    with big.open('wb') as f:
        f.truncate(51 * 1024 * 1024)
    os.utime(big, (0, 0))
    capture()
    assert not big.exists()
    assert sum(p.stat().st_size for p in spool.glob('*.json')) <= 50 * 1024 * 1024
    processes = [subprocess.Popen(['bash', str(HOOK), 'stop'], stdin=subprocess.PIPE,
                                 text=True, env=env) for _ in range(12)]
    for i, p in enumerate(processes):
        p.communicate(json.dumps({'n': i}))
        assert p.returncode == 0
    assert len(list(spool.glob('*.json'))) <= 500
    shutil.rmtree(spool)
    spool.write_text('block directory creation')
    capture()
    assert 'spool write failed' in log.read_text()

    # A plugin symlink must resolve its physical checkout before ascending.
    checkout = base / 'checkout'
    shim = checkout / 'integrations/cursor/rivet-den/bin/cursor-den-hook.sh'
    translator = checkout / 'integrations/claude-code/rivet-den/hooks/den-hook.mjs'
    shim.parent.mkdir(parents=True)
    translator.parent.mkdir(parents=True)
    shutil.copy2(ROOT / 'integrations/cursor/rivet-den/bin/cursor-den-hook.sh', shim)
    translator.write_text('')
    plugin = home / '.cursor/plugins/local/rivet-den-cursor'
    plugin.parent.mkdir(parents=True)
    plugin.symlink_to(shim.parent.parent)
    fakebin = base / 'bin'
    fakebin.mkdir()
    fake_node = fakebin / 'node'
    fake_node.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGS_OUT"\n')
    fake_node.chmod(0o755)
    args_out = base / 'args'
    denenv = {**env, 'PATH': str(fakebin) + ':' + os.environ['PATH'], 'ARGS_OUT': str(args_out),
              'RIVETOS_DEN_HOOK_DISABLED': '0'}
    denenv.pop('RIVETOS_ROOT')
    subprocess.run(['bash', str(plugin / 'bin/cursor-den-hook.sh'), 'afterAgentResponse'],
                   input='{}', text=True, env=denenv, check=True)
    assert args_out.read_text().splitlines() == [str(translator), '--harness', 'cursor', 'AfterAgentResponse']

    # The den shim forwards the payload on stdin and drops a duplicate delivery.
    fake_node.write_text('#!/bin/sh\ncat >> "$ARGS_OUT"; echo >> "$ARGS_OUT"\n')
    args_out.unlink()
    for body in ['{"generation_id":"d1"}', '{"generation_id":"d1"}', '{"generation_id":"d2"}']:
        subprocess.run(['bash', str(plugin / 'bin/cursor-den-hook.sh'), 'stop'],
                       input=body, text=True, env=denenv, check=True)
    assert args_out.read_text().splitlines() == ['{"generation_id":"d1"}', '{"generation_id":"d2"}']

    # Intercept fetch in-process: no network, and inspect the real translator's batch.
    preload = base / 'fetch.mjs'
    output = base / 'events.json'
    preload.write_text("import fs from 'node:fs'; globalThis.fetch = async (_url, opts) => {"
                       "fs.writeFileSync(process.env.EVENTS_OUT, opts.body); return {status:200}; };\n")
    real_translator = ROOT / 'integrations/claude-code/rivet-den/hooks/den-hook.mjs'
    node_env = {**env, 'EVENTS_OUT': str(output), 'RIVET_DEN_URL': 'http://offline.invalid',
                'RIVET_DEN_SESSION': 'cursor-test', 'RIVETOS_DEN_HOOK_DISABLED': '0'}
    subprocess.run(['node', '--import', str(preload), str(real_translator), '--harness', 'cursor'],
                   input=json.dumps({'hook_event_name': 'beforeSubmitPrompt', 'prompt': 'hello'}),
                   text=True, env=node_env, check=True)
    assert any(e['type'] == 'message.user' for e in json.loads(output.read_text()))
    for field in ['hook_event_name', 'hookEventName']:
        subprocess.run(['node', '--import', str(preload), str(real_translator), '--harness', 'cursor', 'Ignored'],
                       input=json.dumps({field: 'afterAgentResponse', 'text': field}),
                       text=True, env=node_env, check=True)
        events = json.loads(output.read_text())
        assert any(e['type'] == 'message.agent' and e['text'] == field for e in events)
        assert not any(e['type'] == 'turn.end' for e in events)
print('PASS: spool permissions, duplicate delivery, count/size/concurrency retention, failure log, symlink discovery, response dispatch')
