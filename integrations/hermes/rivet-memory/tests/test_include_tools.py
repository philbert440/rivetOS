"""include_tools default for rivet_memory_browse (postgres #546 parity).

Hermes browse previously returned every role=tool row, so a limit=50
window of a tool-heavy session was unreadable. The memory-recall skill
already documented the MCP default; the in-process tool did not implement it.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .test_empty_browse import _FakeClient


def _row(role: str, content: str, tool_name: str | None = None):
    return (
        "m1",
        role,
        "rivet-hermes",
        content,
        datetime.now(timezone.utc),
        "conv-1",
        tool_name,
        None,
        None,
    )


def test_wants_include_tools_defaults_false():
    from rivet_memory.tools import wants_include_tools

    assert wants_include_tools({}) is False
    assert wants_include_tools({"include_tools": False}) is False
    assert wants_include_tools({"include_tools": True}) is True


def test_wants_include_tools_ignores_truthy_junk():
    from rivet_memory.tools import wants_include_tools

    assert wants_include_tools({"include_tools": "true"}) is False
    assert wants_include_tools({"include_tools": 1}) is False


def test_browse_tool_default_sql_excludes_tool_role():
    from rivet_memory.tools import browse_tool

    fake = _FakeClient([_row("user", "hello")])
    browse_tool(fake, {"limit": 10})
    sql, params = fake.cursor.executed[0]
    assert "m.role <> 'tool'" in sql
    assert "tool" not in params


def test_browse_tool_include_tools_true_omits_role_filter():
    from rivet_memory.tools import browse_tool

    fake = _FakeClient([_row("tool", "[tool] shell", "shell")])
    out = browse_tool(fake, {"include_tools": True, "limit": 10})
    sql = fake.cursor.executed[0][0]
    assert "m.role <> 'tool'" not in sql
    assert "tools excluded" not in out
    assert "[tool] shell" in out


def test_browse_schema_advertises_include_tools():
    from rivet_memory import BROWSE_SCHEMA

    props = BROWSE_SCHEMA["parameters"]["properties"]
    assert "include_tools" in props
    assert props["include_tools"]["type"] == "boolean"
    assert "role=tool" in BROWSE_SCHEMA["description"]
