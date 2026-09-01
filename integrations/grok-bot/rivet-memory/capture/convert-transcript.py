#!/usr/bin/env python3
"""Convert Grok Bot transcript jsonl to Rivet ingest jsonl.
1:1 with source records so ingest ordinals stay stable.
Each assistant row keeps all text plus every tool_use in full.
"""
import json, sys

if len(sys.argv) != 3:
    print(f'Usage: {sys.argv[0]} SRC.jsonl DST.jsonl', file=sys.stderr)
    sys.exit(2)
SRC, DST = sys.argv[1], sys.argv[2]

def parts_of(rec):
    role = rec.get('role') or ''
    msg = rec.get('message') if isinstance(rec.get('message'), dict) else rec
    if isinstance(msg, dict):
        role = role or msg.get('role') or ''
        content = msg.get('content')
    else:
        content = rec.get('content')
    return role, content

def flatten(rec):
    role, content = parts_of(rec)
    chunks = []
    tools = []
    if isinstance(content, str):
        if content.strip():
            chunks.append(content.strip())
    elif isinstance(content, list):
        for p in content:
            if not isinstance(p, dict):
                if p:
                    chunks.append(str(p))
                continue
            t = p.get('type')
            if t in ('text', 'output_text') and p.get('text'):
                chunks.append(p['text'].strip())
            elif t in ('thinking', 'reasoning', 'redacted_thinking'):
                body = p.get('thinking') or p.get('text') or ''
                if body:
                    chunks.append('[thinking] ' + str(body).strip())
            elif t == 'tool_use':
                tools.append({'id': p.get('id'), 'name': p.get('name'), 'input': p.get('input')})
            elif t == 'tool_result':
                chunks.append('[tool_result] ' + str(p.get('content') or '')[:8000])
    text = '\n'.join(c for c in chunks if c)
    return role or 'assistant', text, tools

n_in = n_out = 0
with open(SRC, encoding='utf-8') as fin, open(DST, 'w', encoding='utf-8') as fout:
    for line in fin:
        line = line.strip()
        if not line:
            continue
        n_in += 1
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        role, text, tools = flatten(rec)
        if not text and not tools:
            continue
        out = {'role': role, 'content': text}
        if tools:
            out['tool_calls'] = tools
        # preserve timing if present
        for k in ('createdAt', 'timestamp', 'id'):
            if rec.get(k) is not None:
                out[k] = rec[k]
        fout.write(json.dumps(out, ensure_ascii=False) + '\n')
        n_out += 1
print(f'in={n_in} out={n_out}')
