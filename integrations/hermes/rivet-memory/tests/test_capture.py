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


def test_rotate_session_links_old_to_new_without_closing_either():
    """Alias semantics, not close+new (harness-control-plane § Rotation).

    The breadcrumb is written under the NEW key — opening the successor
    conversation and stamping the link back — and the predecessor is left
    ACTIVE, because a rotation is not the end of a conversation.
    """
    from rivet_memory.capture import Capture

    fake = FakeClient()
    cap = Capture(fake, _ctx)
    try:
        cap.rotate_session(
            "hermes:20260802_225647_6ad0b9",
            "hermes:20260802_231014_b71c40",
            {"reason": "compression", "reset": False},
        )
        _run(cap)
    finally:
        cap.shutdown(timeout=2.0)

    assert fake.closed_session_keys == []
    assert len(fake.appends) == 1
    row = fake.appends[0]
    assert row["session_key"] == "hermes:20260802_231014_b71c40"
    assert row["role"] == "system"
    assert row["metadata"]["kind"] == "session-rotation"
    assert row["metadata"]["previous_session_key"] == "hermes:20260802_225647_6ad0b9"
    assert row["metadata"]["reason"] == "compression"
    assert "20260802_225647_6ad0b9" in row["content"]


def test_provider_session_switch_rotates_instead_of_closing():
    """The breaking change, at the provider boundary hermes actually calls."""
    import rivet_memory

    provider = rivet_memory.RivetMemoryProvider()
    fake = FakeClient()
    recorded = []

    class RecordingCapture:
        def rotate_session(self, previous_key, next_key, metadata=None):
            recorded.append((previous_key, next_key, dict(metadata or {})))

        def close_session(self, session_key):
            recorded.append(("closed", session_key, {}))

    provider._session_id = "20260802_225647_6ad0b9"
    provider._session_key = "hermes:20260802_225647_6ad0b9"
    provider._capture = RecordingCapture()

    # reset=True is a user's /new — still a rotation, with the reason kept.
    provider.on_session_switch(
        "20260802_231014_b71c40", parent_session_id="", reset=True, reason="new_session"
    )
    assert provider._session_key == "hermes:20260802_231014_b71c40"
    assert recorded == [
        (
            "hermes:20260802_225647_6ad0b9",
            "hermes:20260802_231014_b71c40",
            {
                "reason": "new_session",
                "reset": True,
                "rewound": False,
                "parent_session_id": "20260802_225647_6ad0b9",
            },
        )
    ]

    # reset=False (a compaction child) carries the lineage hermes supplied.
    recorded.clear()
    provider.on_session_switch(
        "20260803_090512_1f9ae2",
        parent_session_id="20260802_231014_b71c40",
        reset=False,
        reason="compression",
    )
    assert recorded[0][2]["parent_session_id"] == "20260802_231014_b71c40"
    assert recorded[0][2]["reason"] == "compression"

    # Restating the same id is not a rotation.
    recorded.clear()
    provider.on_session_switch("20260803_090512_1f9ae2")
    assert recorded == []
    assert fake.closed_session_keys == []


def test_session_end_closes_the_whole_rotation_chain():
    """A rotation leaves its predecessor open; the ENDING closes them all.

    Otherwise every /new would leak an active conversation that nothing ever
    marks finished.
    """
    import rivet_memory

    provider = rivet_memory.RivetMemoryProvider()
    closed = []

    class RecordingCapture:
        def rotate_session(self, previous_key, next_key, metadata=None):
            pass

        def close_session(self, session_key):
            closed.append(session_key)

    provider._session_id = "a"
    provider._session_key = "hermes:a"
    provider._capture = RecordingCapture()
    provider.on_session_switch("b", reason="branch")
    provider.on_session_switch("c", reason="compression")

    provider.on_session_end([])

    assert closed == ["hermes:a", "hermes:b", "hermes:c"]


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
        "todays activity",                  # no apostrophe
        "today's standup",                  # with apostrophe
        "anything from this morning?",
        "yesterday's standup",
        "yesterdays standup",               # no apostrophe — bare plural-looking form
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


def test_hint_window_picks_specific_window_when_possible():
    from rivet_memory import _hint_window

    assert _hint_window("what happened this morning") == "this_morning"
    assert _hint_window("yesterday's standup") == "yesterday"
    assert _hint_window("anything this week") == "this_week"
    assert _hint_window("last 24 hours of turns") == "last_24h"
    assert _hint_window("what did we do last week") == "last_7d"
    assert _hint_window("past 14 days of work") == "last_14d"
    assert _hint_window("last two weeks of work") == "last_14d"
    # Generic time cue falls back to today.
    assert _hint_window("what did we do today") == "today"
    assert _hint_window("recently we discussed") == "today"


def test_resolve_window_returns_utc_iso_bounds():
    from rivet_memory.tools import resolve_window
    from datetime import datetime, timezone

    since, before = resolve_window("today")
    assert since is not None and since.endswith("+00:00") or since.endswith("Z")
    assert before is None  # today is open-ended

    since, before = resolve_window("yesterday")
    assert since is not None and before is not None
    assert since < before  # yesterday is bounded

    since, before = resolve_window("last_24h")
    assert since is not None and before is None

    since, before = resolve_window("last_7d")
    assert since is not None and before is None
    age = datetime.now(timezone.utc) - datetime.fromisoformat(since)
    assert 6.5 * 86400 < age.total_seconds() < 7.5 * 86400

    since, before = resolve_window("last_14d")
    assert since is not None and before is None

    # Alias: last_week → rolling last_7d (don't compare two resolve_window
    # calls with == — each samples datetime.now() so micros differ).
    from rivet_memory.tools import _normalize_window

    assert _normalize_window("last_week") == "last_7d"
    since_alias, before_alias = resolve_window("last_week")
    assert since_alias is not None and before_alias is None
    age_alias = datetime.now(timezone.utc) - datetime.fromisoformat(since_alias)
    assert 6.5 * 86400 < age_alias.total_seconds() < 7.5 * 86400

    # Unknown window hard-fails (postgres #408 parity) — never silent no-op.
    import pytest

    with pytest.raises(ValueError, match=r"Unknown window"):
        resolve_window("not_a_real_window")
    with pytest.raises(ValueError, match=r"today"):
        resolve_window("not_a_real_window")
    with pytest.raises(ValueError, match=r"last_7d"):
        resolve_window("not_a_real_window")
    with pytest.raises(ValueError, match=r"Invalid window"):
        resolve_window("   ")
