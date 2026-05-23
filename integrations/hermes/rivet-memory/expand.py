"""DAG traversal over ``ros_summaries``.

Direct port of ``plugins/memory/postgres/src/expand.ts``. ``parent_id`` lives
on the summary row; source messages link through ``ros_summary_sources``.
"""

from __future__ import annotations

# See ``tools.py`` for the rationale behind this namespace bootstrap.
import sys as _sys
import types as _types

_top = __name__.split(".", 1)[0]
if _top.startswith("_") and _top not in _sys.modules:
    _sys.modules[_top] = _types.ModuleType(_top)

from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional

from .client import RivetMemoryClient


@dataclass
class SummaryNode:
    summary_id: str
    conversation_id: Optional[str]
    kind: str
    depth: int
    content: str
    message_count: int
    earliest_at: Optional[datetime]
    latest_at: Optional[datetime]
    created_at: datetime
    model: Optional[str]
    access_count: int


@dataclass
class SourceMessage:
    message_id: str
    role: str
    content: str
    created_at: datetime


@dataclass
class ExpandResult:
    summary: SummaryNode
    children: List[SummaryNode]
    source_messages: List[SourceMessage]


_SUMMARY_COLUMNS = """
id, conversation_id, kind, depth, content, message_count,
earliest_at, latest_at, created_at, model, access_count
"""


def _row_to_summary(row: tuple) -> SummaryNode:
    return SummaryNode(
        summary_id=str(row[0]),
        conversation_id=str(row[1]) if row[1] is not None else None,
        kind=row[2],
        depth=row[3],
        content=row[4],
        message_count=row[5],
        earliest_at=row[6],
        latest_at=row[7],
        created_at=row[8],
        model=row[9],
        access_count=row[10] or 0,
    )


class Expander:
    def __init__(self, client: RivetMemoryClient) -> None:
        self._client = client

    def describe(self, summary_id: str) -> Optional[SummaryNode]:
        with self._client.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {_SUMMARY_COLUMNS} FROM ros_summaries WHERE id = %s",
                    (summary_id,),
                )
                row = cur.fetchone()
        return _row_to_summary(row) if row else None

    def expand(self, summary_id: str) -> Optional[ExpandResult]:
        summary = self.describe(summary_id)
        if summary is None:
            return None
        children = self._get_children(summary_id)
        sources = self._get_source_messages(summary_id)
        return ExpandResult(summary=summary, children=children, source_messages=sources)

    def expand_deep(self, summary_id: str, max_depth: int = 3) -> Optional[ExpandResult]:
        result = self.expand(summary_id)
        if result is None or max_depth <= 1:
            return result
        for child in result.children:
            child_result = self.expand_deep(child.summary_id, max_depth - 1)
            if child_result is not None:
                result.source_messages.extend(child_result.source_messages)
        return result

    # -- Internal -----------------------------------------------------------

    def _get_children(self, summary_id: str) -> List[SummaryNode]:
        with self._client.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT {_SUMMARY_COLUMNS} FROM ros_summaries "
                    "WHERE parent_id = %s ORDER BY created_at",
                    (summary_id,),
                )
                rows = cur.fetchall()
        return [_row_to_summary(r) for r in rows]

    def _get_source_messages(self, summary_id: str) -> List[SourceMessage]:
        with self._client.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT m.id, m.role, m.content, m.created_at
                      FROM ros_messages m
                      JOIN ros_summary_sources ss ON ss.message_id = m.id
                     WHERE ss.summary_id = %s
                     ORDER BY ss.ordinal
                    """,
                    (summary_id,),
                )
                rows = cur.fetchall()
        return [
            SourceMessage(
                message_id=str(r[0]),
                role=r[1],
                content=r[2] or "",
                created_at=r[3],
            )
            for r in rows
        ]
