#!/usr/bin/env python3
"""usage: gate.py <workspace-root> — the mechanical gate for the Rust runtime (design: ports & adapters).
Checks: (1) dependency direction from Cargo.toml: foundation <- kernel <- adapters/services <- composition; adapters never
depend on adapters or services; services never depend on adapters; only composition depends on adapters. (2) forbidden
patterns in production code: comments, allow attributes, unwrap/expect, unsafe, Js* types, serde_json::Value in pub fields,
string dispatch on wire tags, den/room identifiers, runtime construction outside the binary. (3) file size ceiling (600).
Exit 1 on any finding. Test code (tests/, #[cfg(test)]) is exempt from (2) except comments and unsafe."""
import os, re, sys, tomllib
root = sys.argv[1]
LAYER = {'wire': 0, 'config': 0, 'kernel': 1, 'testkit': 1,
         'memory-postgres': 2, 'memory-sqlite': 2, 'providers': 2, 'harness-acp': 2, 'harness-codex': 2, 'harness-claude': 2,
         'harness-headless': 2, 'terminal': 2, 'tools': 2, 'skills': 2, 'hooks': 2, 'mcp': 2, 'capture': 2, 'transcripts': 2,
         'agents': 2, 'mesh': 2, 'ca': 2, 'local-db': 2, 'wiki': 2, 'workflows': 2, 'tasks': 2,
         'gateway': 3, 'sessions': 3, 'agent-loop': 3, 'workers': 3,
         'cli': 4, 'rivetos': 4}
ADAPTER, SERVICE, COMPOSITION = 2, 3, 4
findings = []
crates = {}
for name in sorted(os.listdir(os.path.join(root, 'crates'))):
    p = os.path.join(root, 'crates', name, 'Cargo.toml')
    if not os.path.exists(p): continue
    t = tomllib.load(open(p, 'rb'))
    deps = {k for sec in ('dependencies', 'dev-dependencies') for k, v in t.get(sec, {}).items() if isinstance(v, dict) and 'path' in v}
    dev = {k for k, v in t.get('dev-dependencies', {}).items() if isinstance(v, dict) and 'path' in v}
    crates[name] = (deps, dev)
    if name not in LAYER: findings.append(f'DEP {name}: not in the crate map (add it to the design first)')
for name, (deps, dev) in crates.items():
    me = LAYER.get(name, 9)
    for d in deps:
        them = LAYER.get(d, 9)
        if d == 'testkit' and d in dev: continue
        if them > me or (me == ADAPTER and them in (ADAPTER, SERVICE)) or (me == SERVICE and them == ADAPTER) or (me == SERVICE and them == SERVICE and d != name):
            findings.append(f'DEP {name} -> {d}: forbidden ({"adapter->adapter" if me==them==ADAPTER else "points up or sideways"})')
PROD = [
    (re.compile(r'^\s*//|/\*'), 'comment'),
    (re.compile(r'#!?\[allow\('), 'allow attribute'),
    (re.compile(r'\.(unwrap|expect)\('), 'unwrap/expect in production code'),
    (re.compile(r'\bunsafe\b'), 'unsafe'),
    (re.compile(r'\bJs(Value|String|Object|Number|Array)\b'), 'JavaScript value model type'),
    (re.compile(r'^\s*pub\s+\w+\s*:\s*(serde_json::)?(Value|Map<String,\s*Value>)'), 'untyped JSON in a public field'),
    (re.compile(r'match\s+\w+(\.\w+\(\))*\.as_str\(\)\s*\{'), 'string dispatch on a wire tag (use an enum)'),
    (re.compile(r'\b\w*([Dd]en_|_den\b|Den[A-Z]|[Rr]oom_|_room\b|Room[A-Z])\w*'), 'den/room identifier'),
    (re.compile(r'tokio::runtime::Builder|#\[tokio::main\]'), 'runtime construction outside the binary'),
    (re.compile(r'\bstd::sync::(Mutex|RwLock)\b'), 'std lock (use parking_lot or tokio::sync)'),
]
ALWAYS = {'comment', 'unsafe'}
for dp, dn, fn in os.walk(os.path.join(root, 'crates')):
    dn[:] = [d for d in dn if d not in ('target', 'golden', 'fixtures')]
    for f in fn:
        if not f.endswith('.rs'): continue
        path = os.path.join(dp, f); rel = os.path.relpath(path, root)
        crate = rel.split(os.sep)[1]
        text = open(path, errors='replace').read(); lines = text.split('\n')
        is_test = '/tests/' in '/' + rel or crate == 'testkit'
        prod_lines = sum(1 for l in lines if l.strip()) if not is_test else 0
        if prod_lines > 600: findings.append(f'SIZE {rel}: {prod_lines} lines (ceiling 600)')
        in_test = False
        for i, line in enumerate(lines, 1):
            if '#[cfg(test)]' in line: in_test = True
            for rx, label in PROD:
                if label == 'runtime construction outside the binary' and crate == 'rivetos': continue
                if label == 'den/room identifier' and re.search(r'"[^"]*(den|room)[^"]*"', line): continue
                if (in_test or is_test) and label not in ALWAYS: continue
                if rx.search(line): findings.append(f'{label.upper().split()[0]} {rel}:{i}: {label}: {line.strip()[:90]}')
for f in findings: print(f)
print(f'GATE {"FAIL" if findings else "OK"}: {len(findings)} finding(s), {len(crates)} crates')
sys.exit(1 if findings else 0)
