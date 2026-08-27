"""Empty-path + filter-note UX for rivet_memory_browse (postgres MCP parity).

Bare ``"No messages found."`` was a residual footgun after #437/#440:
MCP browse already echoes window bounds and next-step hints; Hermes
returned only the four-word empty string, so agents trusted a false
negative when the filter was just too tight.
"""

from __future__ import annotations

from contextlib import contextmanager
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


def test_format_browse_filter_note_window_with_bounds():
    from rivet_memory.tools import format_browse_filter_note

    note = format_browse_filter_note(
        window="today",
        since="2026-08-07T04:00:00+00:00",
        before=None,
    )
    assert 'window="today"' in note
    assert "since=2026-08-07T04:00:00+00:00" in note
    assert note.startswith("\n_")
    assert note.endswith("_")


def test_format_browse_filter_note_explicit_since_before():
    from rivet_memory.tools import format_browse_filter_note

    note = format_browse_filter_note(
        since="2026-08-01T00:00:00Z",
        before="2026-08-02T00:00:00Z",
    )
    assert "since=2026-08-01T00:00:00Z" in note
    assert "before=2026-08-02T00:00:00Z" in note
    assert "window=" not in note


def test_format_browse_filter_note_empty_without_bounds():
    from rivet_memory.tools import format_browse_filter_note

    # Default still echoes the tools-excluded note (postgres #546 parity).
    default = format_browse_filter_note()
    assert "tools excluded" in default
    assert default.startswith("\n_")
    # window alone without resolved bounds is not enough to echo time filters
    window_only = format_browse_filter_note(window="today")
    assert 'window="today"' not in window_only
    assert "tools excluded" in window_only
    # Opting into tools with no time bounds → empty note
    assert format_browse_filter_note(include_tools=True) == ""
    assert format_browse_filter_note(window="today", include_tools=True) == ""


def test_format_empty_browse_result_guides_agent():
    from rivet_memory.tools import format_empty_browse_result

    msg = format_empty_browse_result(
        window="yesterday",
        since="2026-08-06T04:00:00+00:00",
        before="2026-08-07T04:00:00+00:00",
    )
    assert msg.startswith("No messages found.")
    assert msg != "No messages found."
    assert 'window="yesterday"' in msg
    assert "wider window" in msg
    assert "rivet_memory_search" in msg
    assert "agent/conversation" in msg
    # Default empty path still suggests the opt-in flag.
    assert "include_tools=true" in msg

    opted_in = format_empty_browse_result(
        window="yesterday",
        since="2026-08-06T04:00:00+00:00",
        before="2026-08-07T04:00:00+00:00",
        include_tools=True,
    )
    assert opted_in.startswith("No messages found.")
    assert "wider window" in opted_in
    assert "rivet_memory_search" in opted_in
    # Caller already set the flag — do not tell them to pass it again.
    assert "include_tools=true" not in opted_in
    assert "pass include_tools" not in opted_in


def test_browse_tool_empty_with_window_echoes_filters():
    """Handler-level: empty rows + window= → filter note + next-step hints."""
    from rivet_memory.tools import browse_tool

    fake = _FakeClient([])
    out = browse_tool(fake, {"window": "today", "limit": 50})
    assert out.startswith("No messages found.")
    assert 'window="today"' in out
    assert "since=" in out
    assert "wider window" in out
    assert "rivet_memory_search" in out
    # Must not be the bare four-word footgun
    assert out.strip() != "No messages found."


def test_browse_tool_empty_without_filters_still_hints():
    from rivet_memory.tools import browse_tool

    fake = _FakeClient([])
    out = browse_tool(fake, {})
    assert out.startswith("No messages found.")
    assert "wider window" in out
    assert "rivet_memory_search" in out


def test_browse_tool_nonempty_header_includes_filter_note():
    """Success path also echoes window= (postgres header parity)."""
    from datetime import datetime, timezone

    from rivet_memory.tools import browse_tool

    # Columns: id, role, agent, content, created_at, conversation_id,
    # tool_name, tool_result, metadata
    row = (
        "m1",
        "user",
        "rivet-hermes",
        "hello",
        datetime.now(timezone.utc),
        "conv-1",
        None,
        None,
        None,
    )
    fake = _FakeClient([row])
    out = browse_tool(fake, {"window": "last_7d", "limit": 10})
    assert out.startswith("## Messages (1 returned")
    assert 'window="last_7d"' in out
    assert "hello" in out
    assert "tools excluded" in out
    sql = fake.cursor.executed[0][0]
    assert "m.role <> 'tool'" in sql
