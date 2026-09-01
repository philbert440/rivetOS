#!/usr/bin/env python3
"""Convert Grok Bot transcript jsonl to Rivet ingest jsonl.
Emits one output row per source line (strict 1:1) so ordinals stay stable.
Blank/unparseable/contentless source lines become placeholder rows.
Each assistant row keeps all text plus every tool_use in full.
Output uses camelCase (toolCalls, createdAt) matching ingestSession interface.
"""
import json
import sys
from datetime import datetime


if len(sys.argv) != 3:
    print(f'Usage: {sys.argv[0]} SRC.jsonl DST.jsonl', file=sys.stderr)
    sys.exit(2)
SRC, DST = sys.argv[1], sys.argv[2]


def normalize_timestamp(raw):
    """Normalize various timestamp formats to ISO-8601 for new Date()."""
    if not raw:
        return None
    # If already a string, assume ISO or parseable
    if isinstance(raw, str):
        try:
            # Validate it's parseable
            datetime.fromisoformat(raw.replace('Z', '+00:00'))
            return raw
        except (ValueError, AttributeError):
            pass
    # Unix timestamp (seconds or milliseconds)
    if isinstance(raw, (int, float)):
        try:
            # Heuristic: > 1e10 is likely milliseconds
            if raw > 1e10:
                dt = datetime.utcfromtimestamp(raw / 1000.0)
            else:
                dt = datetime.utcfromtimestamp(raw)
            return dt.isoformat() + 'Z'
        except (ValueError, OSError):
            pass
    return None


def extract_tool_result_text(content):
    """Extract text from tool_result content (may be string, list, or dict)."""
    if isinstance(content, str):
        return content[:8000]
    if isinstance(content, list):
        # Claude-shaped: list of text blocks
        chunks = []
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'text':
                chunks.append(str(block.get('text', '')))
            elif isinstance(block, str):
                chunks.append(block)
            else:
                chunks.append(str(block))
        return '\n'.join(chunks)[:8000]
    if isinstance(content, dict):
        # Extract text field if present
        return str(content.get('text') or content)[:8000]
    return str(content)[:8000]


def parts_of(rec):
    """Extract role and content from various Grok Bot message shapes."""
    if not isinstance(rec, dict):
        return '', rec if isinstance(rec, str) else None

    role = rec.get('role') or ''
    msg = rec.get('message') if isinstance(rec.get('message'), dict) else rec
    if isinstance(msg, dict):
        role = role or msg.get('role') or ''
        content = msg.get('content')
    else:
        content = rec.get('content')
    return role, content


def flatten(rec):
    """Flatten Grok Bot message into role, text, and toolCalls."""
    role, content = parts_of(rec)
    chunks = []
    tools = []
    if isinstance(content, str):
        if content.strip():
            chunks.append(content.strip())
    elif isinstance(content, list):
        for p in content:
            if not isinstance(p, dict):
                # Non-dict content part (e.g. string in list)
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
                # Keep tool_result text inline (not as toolCalls)
                result_text = extract_tool_result_text(p.get('content'))
                if result_text:
                    chunks.append('[tool_result] ' + result_text)
    text = '\n'.join(c for c in chunks if c)
    # Default role to assistant if missing (common in Grok Bot transcripts)
    return role or 'assistant', text, tools


n_in = n_out = 0
n_bad = 0
tmp_dst = DST + '.tmp'

with open(SRC, encoding='utf-8', errors='replace') as fin, open(tmp_dst, 'w', encoding='utf-8') as fout:
    for line_no, line in enumerate(fin, start=1):
        line = line.strip()
        n_in += 1

        # Parse source record
        rec = None
        if line:
            try:
                rec = json.loads(line)
                if not isinstance(rec, dict):
                    rec = None
            except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
                n_bad += 1
                rec = None

        # Emit placeholder for blank/bad/contentless lines (ordinal stability)
        if not rec:
            out = {'role': 'assistant', 'content': ''}
            fout.write(json.dumps(out, ensure_ascii=False) + '\n')
            n_out += 1
            continue

        role, text, tools = flatten(rec)

        # Even if text/tools empty, emit row (ordinal stability)
        out = {'role': role, 'content': text}
        if tools:
            # camelCase to match IngestMessage interface
            out['toolCalls'] = tools

        # Preserve timing, normalizing to ISO-8601, using camelCase
        for k in ('createdAt', 'timestamp', 'created_at'):
            if rec.get(k) is not None:
                normalized = normalize_timestamp(rec[k])
                if normalized:
                    out['createdAt'] = normalized
                    break

        # Preserve id if present
        if rec.get('id') is not None:
            out['id'] = rec['id']

        fout.write(json.dumps(out, ensure_ascii=False) + '\n')
        n_out += 1

# Atomic replace
import os
os.replace(tmp_dst, DST)

print(f'in={n_in} out={n_out} bad={n_bad}', file=sys.stderr)
