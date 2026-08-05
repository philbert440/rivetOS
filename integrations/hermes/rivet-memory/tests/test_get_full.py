"""rivet_memory_get_full unit tests.

Ports the coverage of ``plugins/memory/postgres/src/tools/get-full-tool.test.ts``
(JSONL re-derivation + truncation hint) and adds handler-level tests over the
fake-client pattern from ``test_recall.py``: not-truncated rows, missing disk
pointers, gone files, and a full recovery round-trip from a real temp JSONL.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, List, Tuple


class _FakeCursor:
    def __init__(self, rows: List[Tuple]) -> None:
        self.executed: List[Tuple[str, List[Any]]] = []
        self._rows = rows

    def execute(self, sql: str, params=None) -> None:
        self.executed.append((sql, list(params or [])))

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def commit(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeClient:
    def __init__(self, rows: List[Tuple]) -> None:
        self.cursor = _FakeCursor(rows)

    @contextmanager
    def connection(self):
        yield _FakeConn(self.cursor)


# ---------------------------------------------------------------------------
# extract_full_from_line — JSONL re-derivation parity with the TS original
# ---------------------------------------------------------------------------


def test_extracts_full_bash_output_from_session_update_line():
    from rivet_memory.get_full import extract_full_from_line

    line = json.dumps(
        {
            "method": "session/update",
            "params": {
                "_meta": {"promptId": "p1"},
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "rawOutput": {
                        "type": "Bash",
                        "output_for_prompt": "x" * 20000,
                        "exit_code": 0,
                    },
                },
            },
        }
    )
    _, tool_result = extract_full_from_line(line)
    assert tool_result is not None
    assert len(tool_result) > 20000 - 1
    assert "[exit_code=0]" in tool_result


def test_extracts_mcp_envelope_output():
    from rivet_memory.get_full import extract_full_from_line

    line = json.dumps(
        {
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "rawOutput": {
                        "type": "MCP",
                        "server_name": "rivetos",
                        "tool_name": "memory_browse",
                        "output": {"OkayOutput": "big payload here"},
                    },
                },
            },
        }
    )
    _, tool_result = extract_full_from_line(line)
    assert tool_result == "[mcp rivetos/memory_browse]\nbig payload here"


def test_extracts_message_text_and_prefixes_thinking():
    from rivet_memory.get_full import extract_full_from_line

    msg = json.dumps(
        {
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"text": "hello world"},
                },
            },
        }
    )
    assert extract_full_from_line(msg)[0] == "hello world"

    thought = json.dumps(
        {
            "params": {
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "content": [{"type": "text", "text": "hmm"}],
                },
            },
        }
    )
    assert extract_full_from_line(thought)[0] == "[thinking] hmm"


def test_never_raises_on_malformed_lines():
    from rivet_memory.get_full import extract_full_from_line

    assert extract_full_from_line("not json") == ("", None)
    assert extract_full_from_line("{}")[0] == ""


def test_byte_arrays_collapse_to_strings():
    from rivet_memory.get_full import _strip_byte_arrays

    payload = {"data": [104, 105] + [33] * 30}  # "hi!!!…" as a byte list
    stripped = _strip_byte_arrays(payload)
    assert isinstance(stripped["data"], str)
    assert stripped["data"].startswith("hi!")


# ---------------------------------------------------------------------------
# _truncation_hint — browse marker parity with helpers.ts truncationHint
# ---------------------------------------------------------------------------


def test_hint_empty_for_complete_rows():
    from rivet_memory.tools import _truncation_hint

    assert _truncation_hint(None, "x") == ""
    assert _truncation_hint({}, "x") == ""
    assert _truncation_hint({"truncated": False}, "x") == ""


def test_hint_carries_length_and_get_full_handle():
    from rivet_memory.tools import _truncation_hint

    hint = _truncation_hint(
        {"truncated": True, "full_tool_result_length": 52340}, "row-9"
    )
    assert "52340 chars" in hint
    assert "rivet_memory_get_full id=row-9" in hint


# ---------------------------------------------------------------------------
# get_full_tool — handler soft paths + full recovery round-trip
# ---------------------------------------------------------------------------


def test_id_required():
    from rivet_memory.get_full import get_full_tool

    assert "required" in get_full_tool(_FakeClient([]), {})


def test_unknown_id_soft_response():
    from rivet_memory.get_full import get_full_tool

    out = get_full_tool(_FakeClient([]), {"id": "00000000-0000-0000-0000-000000000000"})
    assert out.startswith("No message with id")


def test_not_truncated_row_returns_stored_payload():
    from rivet_memory.get_full import get_full_tool

    row = ("m1", "stored content", "Bash", "stored result", {})
    out = get_full_tool(_FakeClient([row]), {"id": "m1"})
    assert "row was not truncated" in out
    assert "stored content" in out
    assert "[tool: Bash]" in out


def test_truncated_without_pointer_is_unrecoverable():
    from rivet_memory.get_full import get_full_tool

    row = ("m1", "…", None, None, {"truncated": True})
    out = get_full_tool(_FakeClient([row]), {"id": "m1"})
    assert "no disk pointer" in out


def test_truncated_with_missing_file_is_unrecoverable():
    from rivet_memory.get_full import get_full_tool

    meta = {
        "truncated": True,
        "session_jsonl_path": "/nonexistent/updates.jsonl",
        "session_jsonl_line": 3,
    }
    row = ("m1", "…", None, None, meta)
    out = get_full_tool(_FakeClient([row]), {"id": "m1"})
    assert "gone or invalid" in out


def test_full_recovery_round_trip(tmp_path):
    from rivet_memory.get_full import get_full_tool

    big = "y" * 30000
    lines = [
        json.dumps({"params": {"update": {"sessionUpdate": "noise"}}}),
        json.dumps(
            {
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "rawOutput": {
                            "type": "Bash",
                            "output_for_prompt": big,
                            "exit_code": 0,
                        },
                    },
                },
            }
        ),
    ]
    jsonl = tmp_path / "updates.jsonl"
    jsonl.write_text("\n".join(lines) + "\n", encoding="utf-8")

    meta = {
        "truncated": True,
        "session_jsonl_path": str(jsonl),
        "session_jsonl_line": 1,
        "full_tool_result_length": len(big),
    }
    row = ("m1", "truncated preview…", "Bash", "truncated…", meta)
    out = get_full_tool(_FakeClient([row]), {"id": "m1"})
    assert "## Full payload for m1" in out
    assert big in out
    assert "[exit_code=0]" in out


# ---------------------------------------------------------------------------
# Wiring — schema registration, dispatch, and browse hint emission
# ---------------------------------------------------------------------------


def test_get_full_registered_in_tool_schemas():
    from rivet_memory import ALL_TOOL_SCHEMAS

    names = [s["name"] for s in ALL_TOOL_SCHEMAS]
    assert names == [
        "rivet_memory_search",
        "rivet_memory_browse",
        "rivet_memory_stats",
        "rivet_memory_get_full",
    ]


def test_dispatch_routes_get_full():
    from rivet_memory.recall import SearchEngine
    from rivet_memory.tools import Tools

    client = _FakeClient([])
    tools = Tools(client, SearchEngine(client))
    out = tools.dispatch("rivet_memory_get_full", {"id": "nope"})
    assert out.startswith("No message with id")


def test_browse_emits_truncation_hint():
    from rivet_memory.recall import SearchEngine
    from rivet_memory.tools import Tools

    now = datetime.now(timezone.utc)
    # Columns: id, role, agent, content, created_at, conversation_id,
    # tool_name, tool_result, metadata
    rows = [
        (
            "m-trunc",
            "tool",
            "grok",
            "preview…",
            now,
            "conv-1",
            "Bash",
            "partial tool out",
            {"truncated": True, "full_tool_result_length": 20459},
        ),
        ("m-ok", "user", "rivet-hermes", "hello", now, "conv-1", None, None, None),
    ]
    client = _FakeClient(rows)
    tools = Tools(client, SearchEngine(client))
    out = tools.dispatch("rivet_memory_browse", {"limit": 10})
    assert "⚠ truncated at capture (full: 20459 chars)" in out
    assert "rivet_memory_get_full id=m-trunc" in out
    # tool_result preview is included even on capture-truncated rows
    assert "tool_result (Bash)" in out
    assert "partial tool out" in out
    # complete rows carry no capture hint
    assert out.count("truncated at capture") == 1


def test_format_browse_message_body_includes_tool_result():
    from rivet_memory.tools import _format_browse_message_body

    body = _format_browse_message_body(
        "m2",
        "[tool] search_tool",
        "search_tool",
        "Found 3 matching files under packages/cli",
        None,
    )
    assert "[tool] search_tool" in body
    assert "[tool_result (search_tool)]" in body
    assert "Found 3 matching files under packages/cli" in body


def test_format_browse_message_body_display_trunc_points_at_get_full():
    from rivet_memory.tools import _format_browse_message_body

    long_result = "y" * 1200
    body = _format_browse_message_body(
        "m4",
        "[tool] Bash",
        "Bash",
        long_result,
        None,
        tool_result_limit=800,
    )
    assert "tool_result (Bash) 1200 chars" in body
    assert "display-truncated tool_result → rivet_memory_get_full id=m4" in body
