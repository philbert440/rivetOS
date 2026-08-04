"""rivet_memory_get_full — recover the full payload for a capture-truncated row.

Port of ``plugins/memory/postgres/src/tools/get-full-tool.ts``. Capture
truncates content/tool_result at 16K but records a disk pointer
(``metadata.session_jsonl_path`` + ``session_jsonl_line``) back to the source
updates.jsonl (issue #197). This tool re-reads that line and re-derives the
full text. No re-ingest, no DB write — just a disk read.

The tool accepts ONLY a row id. The disk path always comes from the row's own
metadata (written by our capture worker), never from the caller — a model-
facing tool must not be a generic read-any-file primitive.

The JSONL parsing below is a thin duplicate of the capture worker's logic —
keep in sync with the TS original and
``integrations/grok/rivet-memory/capture/src/grok-memory-capture.ts``.
"""

from __future__ import annotations

# See ``tools.py`` for the rationale behind this namespace bootstrap.
import sys as _sys
import types as _types

_top = __name__.split(".", 1)[0]
if _top.startswith("_") and _top not in _sys.modules:
    _sys.modules[_top] = _types.ModuleType(_top)

import json
import os
from typing import Any, Dict, Optional, Tuple

from .client import RivetMemoryClient

PREVIEW_GUARD = 512 * 1024  # sanity cap on what we return in one call


# --- thin duplicates of capture-worker parsing (keep in sync) --------------


def _bytes_to_string(arr: list) -> str:
    try:
        return bytes(arr).decode("utf-8")
    except Exception:
        return f"[{len(arr)} bytes]"


def _is_byte(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 255


def _strip_byte_arrays(obj: Any, depth: int = 0) -> Any:
    if depth > 6 or obj is None:
        return obj
    if isinstance(obj, list):
        if len(obj) >= 16 and all(_is_byte(v) for v in obj):
            return _bytes_to_string(obj)
        return [_strip_byte_arrays(v, depth + 1) for v in obj]
    if isinstance(obj, dict):
        return {k: _strip_byte_arrays(v, depth + 1) for k, v in obj.items()}
    return obj


def _extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    if isinstance(content, list):
        return "\n".join(t for t in (_extract_text(c) for c in content) if t)
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""


def _format_tool_result(update: Any) -> Optional[str]:
    out = update.get("rawOutput") if isinstance(update, dict) else None
    if isinstance(out, list):
        # JS `typeof [] === 'object'` falls through to the generic stringify.
        try:
            return json.dumps(_strip_byte_arrays(out))
        except Exception:
            return None
    if not isinstance(out, dict):
        return None

    t = out.get("type")
    if t == "Bash":
        ofp = out.get("output_for_prompt")
        if isinstance(ofp, str):
            tail = f"exit_code={out.get('exit_code', '?')}"
            if out.get("timed_out"):
                tail += " timed_out=true"
            if out.get("truncated"):
                tail += " truncated=true"
            return f"{ofp}\n[{tail}]"
    elif t == "GrepSearch":
        ofp = out.get("output_for_prompt")
        if isinstance(ofp, str):
            return ofp
        stdout = out.get("stdout")
        if isinstance(stdout, list):
            return _bytes_to_string(stdout)
    elif t == "ReadFile":
        fc = out.get("FileContent")
        if isinstance(fc, dict) and isinstance(fc.get("content"), str):
            return fc["content"]
    elif t == "SearchTool":
        if isinstance(out.get("content"), str):
            rc = out.get("result_count")
            prefix = f"[result_count={rc}]\n" if _is_int(rc) else ""
            return prefix + out["content"]
    elif t == "MCP":
        header = f"[mcp {out.get('server_name', '?')}/{out.get('tool_name', '?')}]"
        o = out.get("output")
        if isinstance(o, str):
            return f"{header}\n{o}"
        if isinstance(o, dict):
            if isinstance(o.get("OkayOutput"), str):
                return f"{header}\n{o['OkayOutput']}"
            if isinstance(o.get("ErrorOutput"), str):
                return f"{header} ERROR\n{o['ErrorOutput']}"
        try:
            return f"{header}\n{json.dumps(_strip_byte_arrays(o))}"
        except Exception:
            pass
    elif t == "ListDir":
        c = out.get("Content")
        if isinstance(c, dict) and isinstance(c.get("content"), str):
            return c["content"]
    elif t == "Todo":
        tu = out.get("TodosUpdated")
        if isinstance(tu, dict) and isinstance(tu.get("summary_for_prompt"), str):
            return tu["summary_for_prompt"]

    try:
        return json.dumps(_strip_byte_arrays(out))
    except Exception:
        return None


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# --- disk access ------------------------------------------------------------


def _read_jsonl_line(path: str, line_index: int) -> Optional[str]:
    """Read a single 0-indexed line from a (potentially large) file without
    loading the whole thing."""
    with open(path, encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh):
            if i == line_index:
                return line.rstrip("\r\n")
    return None


def extract_full_from_line(raw: str) -> Tuple[str, Optional[str]]:
    """Parse one updates.jsonl line and derive the full (content, tool_result).

    Never raises — malformed lines yield ``("", None)``.
    """
    try:
        j = json.loads(raw)
    except Exception:
        return "", None
    update: Any = None
    if isinstance(j, dict):
        params = j.get("params")
        if isinstance(params, dict):
            update = params.get("update")
        if update is None:
            update = j.get("update")
    if update is None:
        update = j
    text = _extract_text(update.get("content")) if isinstance(update, dict) else ""
    if isinstance(update, dict) and update.get("sessionUpdate") == "agent_thought_chunk":
        content = f"[thinking] {text}"
    else:
        content = text
    return content, _format_tool_result(update)


# --- the tool ----------------------------------------------------------------


def get_full_tool(client: RivetMemoryClient, args: Dict[str, Any]) -> str:
    id_ = args.get("id")
    if not isinstance(id_, str) or not id_:
        return "rivet_memory_get_full: `id` is required (string)."

    try:
        with client.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, content, tool_name, tool_result, metadata "
                    "FROM ros_messages WHERE id = %s::uuid",
                    (id_,),
                )
                row = cur.fetchone()
    except Exception as e:
        return f"rivet_memory_get_full failed: {e}"
    if not row:
        return f"No message with id {id_}."

    _, content, tool_name, tool_result, meta = row
    meta = meta if isinstance(meta, dict) else {}
    if meta.get("truncated") is not True:
        # nothing was elided — the stored row already IS the full payload
        tool = f"\n\n[tool: {tool_name}]\n{tool_result or ''}" if tool_name else ""
        return (
            f"(row was not truncated — stored payload is complete)\n\n"
            f"{content or ''}{tool}"
        )

    file = meta.get("session_jsonl_path")
    line = meta.get("session_jsonl_line")
    if not isinstance(file, str) or not _is_int(line):
        return (
            "Row is truncated but carries no disk pointer (pre-#196 capture, or a "
            "non-grok source) — the elided tail is unrecoverable."
        )
    if not file.endswith(".jsonl") or not os.path.isfile(file):
        return (
            f"Source JSONL is gone or invalid ({file}) — the elided tail is "
            f"unrecoverable. (get_full needs the capture JSONL readable from the "
            f"host running Hermes.)"
        )

    try:
        raw = _read_jsonl_line(file, line)
    except Exception as e:
        return f"Failed reading {file}:{line}: {e}"
    if raw is None:
        return f"Line {line} not found in {file} (file rotated/rewritten?)."

    full_content, full_tool_result = extract_full_from_line(raw)
    sections = [f"## Full payload for {id_} (from {file}:{line})"]
    if _is_num(meta.get("full_content_length")) and full_content:
        sections.append(
            f"### content ({len(full_content)} chars)\n{full_content[:PREVIEW_GUARD]}"
        )
    if _is_num(meta.get("full_tool_result_length")) and full_tool_result:
        label = f" ({tool_name})" if tool_name else ""
        sections.append(
            f"### tool_result{label} ({len(full_tool_result)} chars)\n"
            f"{full_tool_result[:PREVIEW_GUARD]}"
        )
    if len(sections) == 1:
        return (
            f"Re-read {file}:{line} but could not re-derive the elided field — "
            f"the line shape may have changed."
        )
    return "\n\n".join(sections)
