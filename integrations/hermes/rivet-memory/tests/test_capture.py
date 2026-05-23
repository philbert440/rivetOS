"""Capture queue + dispatch unit tests.

Uses a fake client that records ``append_message`` / ``append_many`` /
``close_by_session_key`` calls instead of hitting Postgres.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest


def _ctx():
    return ("hermes:s1", "rivet-hermes", "hermes-cli")


class FakeClient:
    def __init__(self) -> None:
        self.appends: List[Dict[str, Any]] = []
        self.bulk_appends: List[Dict[str, Any]] = []
        self.closed_session_keys: List[tuple] = []

    def append_message(self, **kwargs) -> str:
        self.appends.append(kwargs)
        return f"id-{len(self.appends)}"

    def append_many(self, rows, **kwargs) -> List[str]:
        self.bulk_appends.append({"rows": rows, **kwargs})
        return [f"bulk-{i}" for i in range(len(rows))]

    def close_by_session_key(self, session_key: str, agent: str) -> int:
        self.closed_session_keys.append((session_key, agent))
        return 1


def _run(capture):
    """Drain the capture queue synchronously."""
    capture.flush(timeout=5.0)


def test_ingest_turn_writes_user_then_assistant():
    from rivet_memory.capture import Capture

    fake = FakeClient()
    cap = Capture(fake, _ctx)
    try:
        cap.ingest_turn("hi", "hello")
        _run(cap)
    finally:
        cap.shutdown(timeout=2.0)

    assert len(fake.appends) == 2
    user, asst = fake.appends
    assert user["role"] == "user" and user["content"] == "hi"
    assert asst["role"] == "assistant" and asst["content"] == "hello"
    assert user["session_key"] == "hermes:s1"
    assert user["agent"] == "rivet-hermes"
    assert user["channel"] == "hermes-cli"


def test_ingest_turn_skips_empty_sides():
    from rivet_memory.capture import Capture

    fake = FakeClient()
    cap = Capture(fake, _ctx)
    try:
        cap.ingest_turn("", "only assistant")
        _run(cap)
        cap.ingest_turn("only user", "")
        _run(cap)
    finally:
        cap.shutdown(timeout=2.0)

    roles = [a["role"] for a in fake.appends]
    contents = [a["content"] for a in fake.appends]
    assert roles == ["assistant", "user"]
    assert contents == ["only assistant", "only user"]


def test_memory_write_tags_metadata():
    from rivet_memory.capture import Capture

    fake = FakeClient()
    cap = Capture(fake, _ctx)
    try:
        cap.ingest_memory_write("add", "memory", "note body", {"write_origin": "tool"})
        _run(cap)
    finally:
        cap.shutdown(timeout=2.0)

    assert len(fake.appends) == 1
    row = fake.appends[0]
    assert row["role"] == "system"
    assert row["content"] == "note body"
    assert row["metadata"]["source"] == "hermes-memory-tool"
    assert row["metadata"]["action"] == "add"
    assert row["metadata"]["target"] == "memory"
    assert row["metadata"]["write_origin"] == "tool"


def test_delegation_combines_task_and_result():
    from rivet_memory.capture import Capture

    fake = FakeClient()
    cap = Capture(fake, _ctx)
    try:
        cap.ingest_delegation("do X", "X done", "child-123", extra={"model": "opus"})
        _run(cap)
    finally:
        cap.shutdown(timeout=2.0)

    row = fake.appends[0]
    assert row["role"] == "system"
    assert "do X" in row["content"]
    assert "X done" in row["content"]
    assert row["metadata"]["kind"] == "delegation"
    assert row["metadata"]["child_session_id"] == "child-123"
    assert row["metadata"]["model"] == "opus"


def test_compressed_bulk_inserts_with_marker():
    from rivet_memory.capture import Capture

    fake = FakeClient()
    cap = Capture(fake, _ctx)
    try:
        cap.ingest_compressed(
            [
                {"role": "user", "content": "old user"},
                {"role": "assistant", "content": "old asst"},
                {"role": "bogus", "content": "should be dropped"},
            ]
        )
        _run(cap)
    finally:
        cap.shutdown(timeout=2.0)

    assert len(fake.bulk_appends) == 1
    bulk = fake.bulk_appends[0]
    assert bulk["session_key"] == "hermes:s1"
    rows = bulk["rows"]
    assert len(rows) == 2
    assert all(r["metadata"]["preserved_from"] == "pre-compress" for r in rows)


def test_close_session_dispatches_inactive_mark():
    from rivet_memory.capture import Capture

    fake = FakeClient()
    cap = Capture(fake, _ctx)
    try:
        cap.close_session("hermes:old")
        _run(cap)
    finally:
        cap.shutdown(timeout=2.0)

    assert fake.closed_session_keys == [("hermes:old", "rivet-hermes")]


def test_context_fn_resolved_per_op():
    """Rotating context (e.g. after on_session_switch) takes effect on the next op."""
    from rivet_memory.capture import Capture

    state = {"key": "hermes:a"}

    def ctx():
        return (state["key"], "rivet-hermes", "hermes-cli")

    fake = FakeClient()
    cap = Capture(fake, ctx)
    try:
        cap.ingest_turn("u1", "a1")
        _run(cap)
        state["key"] = "hermes:b"
        cap.ingest_turn("u2", "a2")
        _run(cap)
    finally:
        cap.shutdown(timeout=2.0)

    keys = [a["session_key"] for a in fake.appends]
    assert keys == ["hermes:a", "hermes:a", "hermes:b", "hermes:b"]


def test_invalid_role_raises_in_append_message():
    """Schema sanity — make sure schema constants stay enforced."""
    from rivet_memory import schema as S

    assert S.VALID_ROLES == {"system", "user", "assistant", "tool"}


# ---------------------------------------------------------------------------
# Time-bounded prefetch skip — regression guard for the noisy-prefetch issue
# that grok-4.3 surfaced in the first phildesk Hermes session against this
# plugin: prefetch ran FTS for "what did we do today?" and injected March
# hits that competed with the agent's own browse.
# ---------------------------------------------------------------------------


def test_is_time_bounded_recognizes_common_cues():
    from rivet_memory import _is_time_bounded

    positives = [
        "what did we do today?",
        "anything from this morning?",
        "yesterday's standup",
        "did we touch the router last week",
        "the other day phil mentioned X",
        "a couple days ago we tried Y",
        "3 hours ago I saw an error",
        "recently we discussed compaction",
        "since monday how many turns",
    ]
    for q in positives:
        assert _is_time_bounded(q), f"should be time-bounded: {q!r}"


def test_is_time_bounded_ignores_topic_queries():
    from rivet_memory import _is_time_bounded

    negatives = [
        "what's the frigate IP?",
        "where does deckard live",
        "have we set up nginx anywhere",
        "the dnsmasq error from the WAP",
        "memory plugin install",
    ]
    for q in negatives:
        assert not _is_time_bounded(q), f"should NOT be time-bounded: {q!r}"
