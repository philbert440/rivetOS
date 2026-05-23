"""Recall unit tests.

The key regression target is the ``%s`` ordering bug in ``_search_messages``
/ ``_search_summaries`` — psycopg binds placeholders positionally, and the
SELECT clause's ``ts_rank_cd(%s)`` is rendered before the WHERE clause. If
SELECT-clause params aren't pre-pended to the WHERE-clause params, an
``agent`` or ``since`` filter silently mis-binds the query string.

These tests use a fake cursor that captures executed SQL + params and
returns canned rows.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple


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


def _msg_row(id_="m1", content="hello world", role="user", agent="rivet-hermes"):
    return (
        id_,
        content,
        role,
        agent,
        "conv-1",
        datetime.now(timezone.utc),
        0.42,  # score
    )


def test_fts_message_search_with_agent_filter_param_order():
    """Agent filter is appended AFTER the SELECT-clause %s, so the query
    string lands in websearch_to_tsquery — not in m.agent."""
    from rivet_memory.recall import SearchEngine

    fake = _FakeClient([_msg_row()])
    eng = SearchEngine(fake)
    eng._search_messages(
        "deckard tuning",
        mode="fts",
        limit=10,
        agent="rivet-hermes",
        since=None,
        before=None,
        query_embedding=None,
    )

    sql, params = fake.cursor.executed[0]
    # The FTS WHERE condition is appended first (mode block), then agent.
    # So SQL placeholder order is: ts_rank_cd(%s) [SELECT] →
    # websearch_to_tsquery(%s) [WHERE] → m.agent = %s [WHERE] → LIMIT %s.
    assert params == ["deckard tuning", "deckard tuning", "rivet-hermes", 10]
    # Sanity-check the SQL placeholder positions to lock the contract.
    rank_pos = sql.index("ts_rank_cd(m.content_tsv, websearch_to_tsquery('english', %s))")
    query_pos = sql.index("m.content_tsv @@ websearch_to_tsquery('english', %s)")
    agent_pos = sql.index("m.agent = %s")
    assert rank_pos < query_pos < agent_pos


def test_fts_summary_search_param_order_with_since():
    from rivet_memory.recall import SearchEngine

    fake = _FakeClient([])
    eng = SearchEngine(fake)
    eng._search_summaries(
        "phildesk",
        mode="fts",
        limit=5,
        since="2026-01-01",
        before=None,
        query_embedding=None,
    )
    _sql, params = fake.cursor.executed[0]
    assert params == ["phildesk", "phildesk", "2026-01-01", 5]


def test_trigram_messages_skip_embedding_clause():
    from rivet_memory.recall import SearchEngine

    fake = _FakeClient([])
    eng = SearchEngine(fake)
    eng._search_messages(
        "phildez",  # typo of phildesk
        mode="trigram",
        limit=3,
        agent=None,
        since=None,
        before=None,
        query_embedding=None,
    )
    sql, params = fake.cursor.executed[0]
    assert params == ["phildez", "phildez", 3]
    assert "similarity(m.content, %s) > 0.3" in sql
    assert "websearch_to_tsquery" not in sql


def test_regex_mode_omits_score_param():
    from rivet_memory.recall import SearchEngine

    fake = _FakeClient([])
    eng = SearchEngine(fake)
    eng._search_messages(
        r"^err.*timeout$",
        mode="regex",
        limit=4,
        agent=None,
        since=None,
        before=None,
        query_embedding=None,
    )
    _sql, params = fake.cursor.executed[0]
    # regex has no ts_rank_cd or similarity, so the only WHERE %s is the regex
    # and the only LIMIT %s.
    assert params == [r"^err.*timeout$", 4]


def test_fts_with_embedding_inlines_vec_literal():
    """Query embedding is interpolated as a literal — must not appear in params."""
    from rivet_memory.recall import SearchEngine

    fake = _FakeClient([])
    eng = SearchEngine(fake)
    eng._search_messages(
        "kv cache",
        mode="fts",
        limit=5,
        agent=None,
        since=None,
        before=None,
        query_embedding=[0.1, 0.2, 0.3],
    )
    sql, params = fake.cursor.executed[0]
    assert params == ["kv cache", "kv cache", 5]
    assert "halfvec" in sql
    assert "[0.100000,0.200000,0.300000]" in sql


def test_unknown_mode_raises():
    from rivet_memory.recall import SearchEngine

    fake = _FakeClient([])
    eng = SearchEngine(fake)
    try:
        eng._search_messages(
            "x",
            mode="bogus",  # type: ignore[arg-type]
            limit=1,
            agent=None,
            since=None,
            before=None,
            query_embedding=None,
        )
    except ValueError as e:
        assert "unknown search mode" in str(e)
    else:
        raise AssertionError("expected ValueError")
