"""Postgres client for the rivet-memory Hermes plugin.

Owns one psycopg ``ConnectionPool`` per provider instance. All capture/recall
paths borrow connections via ``connection()`` and rely on the pool for
auto-reconnect after transient failures.

Why a pool: Hermes runs many short-lived hooks per turn. Re-establishing a TCP
+ TLS connection per write would be slow and would fight the embedding worker
for connection slots on the datahub side.
"""

from __future__ import annotations

# See ``tools.py`` for the rationale behind this namespace bootstrap.
import sys as _sys
import types as _types

_top = __name__.split(".", 1)[0]
if _top.startswith("_") and _top not in _sys.modules:
    _sys.modules[_top] = _types.ModuleType(_top)

import json
import logging
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Optional

from psycopg_pool import ConnectionPool

from . import schema as S

logger = logging.getLogger(__name__)


def _set_utf8(conn: Any) -> None:
    """Force UTF8 on each pool connection.

    Datahub Postgres is configured with ``client_encoding=ascii`` server-side;
    without an explicit override psycopg returns ``bytes`` for text/varchar
    columns. Setting per-session UTF8 keeps every text column decoded.
    """
    conn.execute("SET client_encoding TO 'UTF8'")
    conn.commit()


class RivetMemoryClient:
    """Thin wrapper around a psycopg ConnectionPool plus ros_* helpers."""

    def __init__(
        self,
        pg_url: str,
        *,
        min_size: int = 1,
        max_size: int = 4,
        timeout: float = 10.0,
    ) -> None:
        if not pg_url:
            raise ValueError("RivetMemoryClient: pg_url is required")
        self._pool = ConnectionPool(
            conninfo=pg_url,
            min_size=min_size,
            max_size=max_size,
            timeout=timeout,
            kwargs={"autocommit": False},
            configure=_set_utf8,
            open=False,
        )
        # Defer the first open until first use — ConnectionPool warms in the
        # background, but we don't want construction to block Hermes startup.
        self._pool.open(wait=False)

    # -- Pool lifecycle ------------------------------------------------------

    def close(self) -> None:
        try:
            self._pool.close()
        except Exception as e:
            logger.debug("rivet_memory: pool close failed: %s", e)

    @contextmanager
    def connection(self) -> Iterator[Any]:
        with self._pool.connection() as conn:
            yield conn

    def ping(self) -> bool:
        """Cheap connectivity check — returns True iff a SELECT 1 succeeds."""
        try:
            with self.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
                    cur.fetchone()
            return True
        except Exception as e:
            logger.debug("rivet_memory: ping failed: %s", e)
            return False

    # -- Conversation helpers ------------------------------------------------

    def ensure_conversation(
        self,
        cur: Any,
        *,
        session_key: str,
        agent: str,
        channel: str,
    ) -> str:
        """Find or create the active conversation for (session_key, agent).

        Caller owns the transaction. Mirrors `ensureConversation` in the
        TS adapter (adapter.ts:389).
        """
        cur.execute(S.SQL_FIND_ACTIVE_CONVERSATION, (session_key, agent))
        row = cur.fetchone()
        if row:
            return row[0]
        cur.execute(
            S.SQL_INSERT_CONVERSATION,
            (session_key, agent, channel or "unknown", f"Session {session_key}"),
        )
        return cur.fetchone()[0]

    def close_conversation(self, conversation_id: str) -> None:
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(S.SQL_CLOSE_CONVERSATION, (conversation_id,))
            conn.commit()

    def close_by_session_key(self, session_key: str, agent: str) -> int:
        """Mark every active conversation for (session_key, agent) inactive.

        Returns the rowcount. Used by on_session_switch(reset=True) and
        on_session_end.
        """
        with self.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(S.SQL_CLOSE_BY_SESSION_KEY, (session_key, agent))
                affected = cur.rowcount
            conn.commit()
        return affected

    # -- Message insert ------------------------------------------------------

    def append_message(
        self,
        *,
        session_key: str,
        agent: str,
        channel: str,
        role: str,
        content: str,
        tool_name: Optional[str] = None,
        tool_args: Optional[Dict[str, Any]] = None,
        tool_result: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Atomic: ensure conversation, insert message, touch updated_at.

        Returns the new ros_messages.id (uuid as str).
        """
        if role not in S.VALID_ROLES:
            raise ValueError(f"append_message: invalid role {role!r}; must be one of {S.VALID_ROLES}")
        meta_json = json.dumps(metadata) if metadata else "{}"
        args_json = json.dumps(tool_args) if tool_args is not None else None
        with self.connection() as conn:
            with conn.cursor() as cur:
                conv_id = self.ensure_conversation(
                    cur,
                    session_key=session_key,
                    agent=agent,
                    channel=channel,
                )
                cur.execute(
                    S.SQL_INSERT_MESSAGE,
                    (
                        conv_id,
                        agent,
                        channel,
                        role,
                        content,
                        tool_name,
                        args_json,
                        tool_result,
                        meta_json,
                        None,  # created_at — let Postgres NOW()
                    ),
                )
                msg_id = cur.fetchone()[0]
                cur.execute(S.SQL_TOUCH_CONVERSATION, (conv_id,))
            conn.commit()
        return str(msg_id)

    def append_many(
        self,
        rows: list[Dict[str, Any]],
        *,
        session_key: str,
        agent: str,
        channel: str,
    ) -> list[str]:
        """Bulk insert in a single transaction sharing one conversation.

        Each row dict supports keys: role (required), content, tool_name,
        tool_args, tool_result, metadata. Used by on_pre_compress to preserve
        a batch of about-to-be-discarded messages.
        """
        if not rows:
            return []
        ids: list[str] = []
        with self.connection() as conn:
            with conn.cursor() as cur:
                conv_id = self.ensure_conversation(
                    cur,
                    session_key=session_key,
                    agent=agent,
                    channel=channel,
                )
                for row in rows:
                    role = row.get("role")
                    if role not in S.VALID_ROLES:
                        raise ValueError(
                            f"append_many: invalid role {role!r}; must be one of {S.VALID_ROLES}"
                        )
                    meta_json = json.dumps(row.get("metadata") or {}) if row.get("metadata") else "{}"
                    args_json = (
                        json.dumps(row["tool_args"])
                        if row.get("tool_args") is not None
                        else None
                    )
                    cur.execute(
                        S.SQL_INSERT_MESSAGE,
                        (
                            conv_id,
                            agent,
                            channel,
                            role,
                            row.get("content", ""),
                            row.get("tool_name"),
                            args_json,
                            row.get("tool_result"),
                            meta_json,
                            None,
                        ),
                    )
                    ids.append(str(cur.fetchone()[0]))
                cur.execute(S.SQL_TOUCH_CONVERSATION, (conv_id,))
            conn.commit()
        return ids
