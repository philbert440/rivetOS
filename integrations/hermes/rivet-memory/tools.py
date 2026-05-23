"""Tool handlers and formatters.

Ports of ``tools/search-tool.ts``, ``tools/browse-tool.ts``, and
``tools/stats-tool.ts`` from ``@rivetos/memory-postgres``, plus the prefetch
formatter that wraps a search response in ``<rivet-memory-context>``.

``Tools.dispatch(name, args)`` is the entry point the provider calls from
``handle_tool_call``. Each handler returns a markdown string the model can
read directly.
"""

from __future__ import annotations

# Bootstrap synthetic top-level namespace for Hermes's user-plugin loader.
# The loader assigns user plugins to ``_hermes_user_memory.<name>`` in
# ``sys.modules`` but never creates ``_hermes_user_memory`` itself, so the
# first submodule loaded (NFS / Windows-backed filesystems don't guarantee
# alphabetical glob order) fails any ``from .x import y`` because Python
# can't find the top-level package. Registering a placeholder here makes
# every relative import in this package work no matter the load order.
import sys as _sys
import types as _types

_top = __name__.split(".", 1)[0]
if _top.startswith("_") and _top not in _sys.modules:
    _sys.modules[_top] = _types.ModuleType(_top)

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .client import RivetMemoryClient
from .expand import Expander, SourceMessage, SummaryNode
from .recall import SearchEngine, SearchHit

logger = logging.getLogger(__name__)

# Compaction worker default. If the deployed worker overrides this, the
# eligibility buckets in stats will be slightly off but order still holds.
_MIN_BATCH_SIZE = 5
_FULL_WINDOW = 10
_IDLE_MINUTES = 15


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_aware(d: datetime) -> datetime:
    return d if d.tzinfo is not None else d.replace(tzinfo=timezone.utc)


def fmt_date(d: Optional[datetime]) -> str:
    if d is None:
        return "?"
    return _ensure_aware(d).date().isoformat()


def time_since(d: datetime) -> str:
    delta = _now_utc() - _ensure_aware(d)
    secs = delta.total_seconds()
    if secs < 60:
        return "just now"
    if secs < 3600:
        return f"{int(secs // 60)}m ago"
    if secs < 86400:
        return f"{int(secs // 3600)}h ago"
    return f"{int(secs // 86400)}d ago"


def _truncate(text: str, n: int) -> str:
    return text if len(text) <= n else text[:n] + "…"


# ---------------------------------------------------------------------------
# Search tool
# ---------------------------------------------------------------------------


class _ExpandedSummary:
    __slots__ = ("hit", "children", "source_messages")

    def __init__(
        self,
        hit: SearchHit,
        children: List[SummaryNode],
        source_messages: List[SourceMessage],
    ) -> None:
        self.hit = hit
        self.children = children
        self.source_messages = source_messages


def _days_ago(d: datetime) -> int:
    return int((_now_utc() - _ensure_aware(d)).total_seconds() // 86400)


def _format_expanded(
    sections: List[str],
    expanded: List[_ExpandedSummary],
    all_summary_hits: List[SearchHit],
) -> None:
    sections.append("### Summaries (expanded)\n")
    for es in expanded:
        hit = es.hit
        age = _days_ago(hit.created_at)
        if hit.earliest_at and hit.latest_at:
            period = f"{fmt_date(hit.earliest_at)} → {fmt_date(hit.latest_at)}"
        else:
            period = fmt_date(hit.created_at)
        sections.append(
            f"**[{hit.kind or 'summary'}]** ({age}d ago, score: {hit.score:.3f}, "
            f"period: {period})"
        )
        sections.append(hit.content)
        if es.children:
            sections.append(f"\n  **Children ({len(es.children)}):**")
            for child in es.children[:5]:
                sections.append(f"  - [{child.kind}] {_truncate(child.content, 200)}")
            if len(es.children) > 5:
                sections.append(f"  - ... and {len(es.children) - 5} more")
        if es.source_messages:
            sections.append(f"\n  **Source messages ({len(es.source_messages)}):**")
            for msg in es.source_messages[:8]:
                sections.append(f"  > [{msg.role}] {_truncate(msg.content, 300)}")
            if len(es.source_messages) > 8:
                sections.append(
                    f"  > ... and {len(es.source_messages) - 8} more messages"
                )
        sections.append("")

    remaining = all_summary_hits[3:]
    if remaining:
        sections.append("### Additional summaries (not expanded)\n")
        for hit in remaining:
            sections.append(
                f"- [{hit.kind or 'summary'}] ({_days_ago(hit.created_at)}d ago, "
                f"score: {hit.score:.3f}) {_truncate(hit.content, 300)}"
            )
        sections.append("")


def _format_unexpanded(sections: List[str], summary_hits: List[SearchHit]) -> None:
    sections.append("### Summaries\n")
    for hit in summary_hits:
        sections.append(
            f"- [{hit.kind or 'summary'}/{hit.id}] ({_days_ago(hit.created_at)}d ago, "
            f"score: {hit.score:.3f}) {_truncate(hit.content, 300)}"
        )
    sections.append("")


def _format_messages(sections: List[str], message_hits: List[SearchHit]) -> None:
    sections.append("### Messages\n")
    for hit in message_hits:
        sections.append(
            f"- [{hit.agent}/{hit.role}] ({_days_ago(hit.created_at)}d ago, "
            f"score: {hit.score:.3f}) {_truncate(hit.content, 400)}"
        )


def search_tool(
    engine: SearchEngine,
    expander: Expander,
    args: Dict[str, Any],
) -> str:
    query = args.get("query", "")
    if not query:
        return "memory_search: `query` is required."

    mode = args.get("mode") or "fts"
    scope = args.get("scope") or "both"
    limit = max(1, min(int(args.get("limit") or 10), 50))
    agent = args.get("agent")
    since = args.get("since")
    before = args.get("before")
    should_expand = args.get("expand") is not False  # default True

    results = engine.search(
        query,
        mode=mode,
        scope=scope,
        limit=limit,
        agent=agent,
        since=since,
        before=before,
    )
    if not results:
        # If filters narrowed the query but it still returned empty, the
        # caller is usually trying to "browse a window" via search. Point
        # them at the right tool so they don't burn a second turn guessing.
        if since or before:
            window = []
            if since:
                window.append(f'since="{since}"')
            if before:
                window.append(f'before="{before}"')
            window_str = ", ".join(window)
            return (
                f'No results found for query "{query}" with {window_str}.\n\n'
                f"For chronological browsing of a date window without a topic "
                f"filter, call `rivet_memory_browse({window_str})` instead — "
                f"that returns every message in the window, no FTS match required."
            )
        # No date filter — likely a missed FTS match. Hint at trigram / angle variation.
        return (
            f'No results found for query "{query}".\n\n'
            f"If you expected a hit: retry with `mode=\"trigram\"` for literal "
            f"tokens (IPs, hostnames, error strings), or vary the angle "
            f"(service / host / subnet / role) and try two more queries before "
            f"trusting the empty result."
        )

    summary_hits = [h for h in results if h.type == "summary"]
    message_hits = [h for h in results if h.type == "message"]

    expanded: List[_ExpandedSummary] = []
    if should_expand and summary_hits:
        for hit in summary_hits[:3]:
            try:
                depth = 3 if hit.score > 0.5 else 2
                exp = expander.expand_deep(hit.id, depth)
                if exp:
                    expanded.append(
                        _ExpandedSummary(hit, exp.children, exp.source_messages)
                    )
                else:
                    expanded.append(_ExpandedSummary(hit, [], []))
            except Exception:
                expanded.append(_ExpandedSummary(hit, [], []))

    sections: List[str] = [
        f'## Memory Search: "{query}"',
        f"Found {len(results)} results "
        f"({len(summary_hits)} summaries, {len(message_hits)} messages)\n",
    ]
    if expanded:
        _format_expanded(sections, expanded, summary_hits)
    elif summary_hits:
        _format_unexpanded(sections, summary_hits)
    if message_hits:
        _format_messages(sections, message_hits)
    return "\n".join(sections)


# ---------------------------------------------------------------------------
# Browse tool
# ---------------------------------------------------------------------------


def browse_tool(client: RivetMemoryClient, args: Dict[str, Any]) -> str:
    conditions: List[str] = []
    params: list = []
    if args.get("conversation_id"):
        conditions.append("m.conversation_id = %s")
        params.append(args["conversation_id"])
    if args.get("agent"):
        conditions.append("m.agent = %s")
        params.append(args["agent"])
    if args.get("since"):
        conditions.append("m.created_at >= %s")
        params.append(args["since"])
    if args.get("before"):
        conditions.append("m.created_at < %s")
        params.append(args["before"])

    limit = max(1, min(int(args.get("limit") or 50), 200))
    order_sql = "ASC" if args.get("order") == "asc" else "DESC"
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"""
        SELECT m.id, m.role, m.agent, m.content, m.created_at,
               m.conversation_id, m.tool_name
          FROM ros_messages m
          {where}
         ORDER BY m.created_at {order_sql}
         LIMIT %s
    """
    params.append(limit)

    try:
        with client.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
    except Exception as e:
        return f"Browse failed: {e}"

    if not rows:
        return "No messages found."

    lines: List[str] = []
    for r in rows:
        ts = _ensure_aware(r[4]).strftime("%Y-%m-%d %H:%M:%S")
        tool = f" [tool: {r[6]}]" if r[6] else ""
        content = _truncate(r[3] or "", 500)
        lines.append(f"[{ts}] {r[2]}/{r[1]}{tool}\n{content}")

    direction = "newest" if order_sql == "DESC" else "oldest"
    return (
        f"## Messages ({len(rows)} returned, {direction} first)\n\n"
        + "\n\n---\n\n".join(lines)
    )


# ---------------------------------------------------------------------------
# Stats tool
# ---------------------------------------------------------------------------


def stats_tool(client: RivetMemoryClient, args: Dict[str, Any]) -> str:
    agent = args.get("agent")
    msg_where = "WHERE agent = %s" if agent else ""
    msg_params: list = [agent] if agent else []
    sections: List[str] = ["## Memory System Health"]

    try:
        with client.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"SELECT COUNT(*), MIN(created_at), MAX(created_at) "
                    f"FROM ros_messages {msg_where}",
                    msg_params,
                )
                total, oldest, newest = cur.fetchone()
                sections.append(
                    f"\n**Messages:** {int(total):,}"
                    f"\n**Date range:** {fmt_date(oldest)} → {fmt_date(newest)}"
                )

                cur.execute(
                    f"SELECT agent, COUNT(*) FROM ros_messages {msg_where} "
                    f"GROUP BY agent ORDER BY 2 DESC",
                    msg_params,
                )
                rows = cur.fetchall()
                if rows:
                    sections.append(
                        "\n**By agent:**\n"
                        + "\n".join(f"  {r[0]}: {int(r[1]):,}" for r in rows)
                    )

                cur.execute(
                    f"SELECT role, COUNT(*) FROM ros_messages {msg_where} "
                    f"GROUP BY role ORDER BY 2 DESC",
                    msg_params,
                )
                rows = cur.fetchall()
                if rows:
                    sections.append(
                        "\n**By role:**\n"
                        + "\n".join(f"  {r[0]}: {int(r[1]):,}" for r in rows)
                    )

                cur.execute(
                    "SELECT COUNT(*), COUNT(*) FILTER (WHERE active) "
                    "FROM ros_conversations"
                )
                ct = cur.fetchone()
                sections.append(f"\n**Conversations:** {ct[0]} total, {ct[1]} active")

                cur.execute(
                    "SELECT kind, COUNT(*), MAX(depth) FROM ros_summaries "
                    "GROUP BY kind ORDER BY 2 DESC"
                )
                rows = cur.fetchall()
                if rows:
                    total_sum = sum(int(r[1]) for r in rows)
                    sections.append(
                        f"\n**Summaries:** {total_sum:,} total\n"
                        + "\n".join(
                            f"  {r[0]}: {int(r[1]):,} (max depth: {r[2]})" for r in rows
                        )
                    )
                else:
                    sections.append(
                        "\n**Summaries:** 0 ⚠️ No summaries — compactor may not be running"
                    )

                cur.execute(
                    """
                    SELECT
                      (SELECT COUNT(*) FROM ros_messages
                        WHERE embedding IS NULL
                          AND content IS NOT NULL
                          AND LENGTH(content) > 0),
                      (SELECT COUNT(*) FROM ros_summaries
                        WHERE embedding IS NULL AND content IS NOT NULL)
                    """
                )
                msg_queue, sum_queue = (int(x) for x in cur.fetchone())
                queue_total = msg_queue + sum_queue
                if queue_total == 0:
                    queue_status = "✅ caught up"
                elif queue_total < 50:
                    queue_status = f"⏳ {queue_total} pending"
                else:
                    queue_status = f"⚠️ {queue_total} pending (backlog)"
                sections.append(
                    f"\n**Embedding queue:** {queue_status}"
                    f"\n  Messages awaiting embedding: {msg_queue:,}"
                    f"\n  Summaries awaiting embedding: {sum_queue:,}"
                )

                cur.execute(
                    "SELECT COUNT(*), COUNT(embedding) FROM ros_messages"
                )
                m_total, m_emb = (int(x) for x in cur.fetchone())
                cur.execute(
                    "SELECT COUNT(*), COUNT(embedding) FROM ros_summaries"
                )
                s_total, s_emb = (int(x) for x in cur.fetchone())
                m_pct = f"{m_emb / m_total * 100:.1f}" if m_total else "0"
                s_pct = f"{s_emb / s_total * 100:.1f}" if s_total else "0"
                sections.append(
                    f"\n**Embedding coverage:**"
                    f"\n  Messages: {m_emb:,}/{m_total:,} ({m_pct}%)"
                    f"\n  Summaries: {s_emb:,}/{s_total:,} ({s_pct}%)"
                )

                cur.execute(
                    """
                    WITH per_conv AS (
                      SELECT c.id AS conversation_id, c.updated_at,
                             COUNT(m.id) AS qualifying
                        FROM ros_conversations c
                        JOIN ros_messages m ON m.conversation_id = c.id
                        LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
                       WHERE ss.summary_id IS NULL
                         AND ((m.content IS NOT NULL AND LENGTH(m.content) > 10)
                              OR m.tool_name IS NOT NULL)
                       GROUP BY c.id
                    )
                    SELECT
                      COALESCE(SUM(qualifying) FILTER (
                        WHERE qualifying >= %s
                           OR (qualifying >= %s AND updated_at < NOW() - (%s || ' minutes')::interval)
                      ), 0),
                      COUNT(*) FILTER (
                        WHERE qualifying >= %s
                           OR (qualifying >= %s AND updated_at < NOW() - (%s || ' minutes')::interval)
                      ),
                      COALESCE(SUM(qualifying) FILTER (
                        WHERE qualifying >= %s AND qualifying < %s
                          AND updated_at >= NOW() - (%s || ' minutes')::interval
                      ), 0),
                      COUNT(*) FILTER (
                        WHERE qualifying >= %s AND qualifying < %s
                          AND updated_at >= NOW() - (%s || ' minutes')::interval
                      ),
                      COALESCE(SUM(qualifying) FILTER (WHERE qualifying < %s), 0),
                      COUNT(*) FILTER (WHERE qualifying < %s)
                      FROM per_conv
                    """,
                    [
                        _FULL_WINDOW, _MIN_BATCH_SIZE, _IDLE_MINUTES,
                        _FULL_WINDOW, _MIN_BATCH_SIZE, _IDLE_MINUTES,
                        _MIN_BATCH_SIZE, _FULL_WINDOW, _IDLE_MINUTES,
                        _MIN_BATCH_SIZE, _FULL_WINDOW, _IDLE_MINUTES,
                        _MIN_BATCH_SIZE,
                        _MIN_BATCH_SIZE,
                    ],
                )
                b = cur.fetchone()
                eligible_msgs, eligible_convs = int(b[0]), int(b[1])
                active_tail_msgs, active_tail_convs = int(b[2]), int(b[3])
                below_msgs, below_convs = int(b[4]), int(b[5])
                total_unsum = eligible_msgs + active_tail_msgs + below_msgs
                if eligible_convs == 0:
                    eligible_status = "✅"
                elif eligible_msgs < 100:
                    eligible_status = "⏳"
                else:
                    eligible_status = "⚠️"
                sections.append(
                    f"\n**Unsummarized messages:** {total_unsum:,} total"
                    f"\n  Eligible for compaction: {eligible_msgs:,} msgs in "
                    f"{eligible_convs:,} convs {eligible_status}"
                    f"\n    (≥{_FULL_WINDOW} unsummarized, OR ≥{_MIN_BATCH_SIZE} + "
                    f"idle ≥{_IDLE_MINUTES}m)"
                    f"\n  Active tail: {active_tail_msgs:,} msgs in "
                    f"{active_tail_convs:,} convs (will flush when idle)"
                    f"\n  Below floor: {below_msgs:,} msgs in {below_convs:,} convs "
                    f"(<{_MIN_BATCH_SIZE} qualifying — won't compact by design)"
                )

                cur.execute(
                    "SELECT MAX(depth), "
                    "COUNT(*) FILTER (WHERE parent_id IS NULL AND kind != 'leaf'), "
                    "COUNT(*) FILTER (WHERE parent_id IS NOT NULL) "
                    "FROM ros_summaries"
                )
                td = cur.fetchone()
                sections.append(
                    f"\n**Summary tree:**"
                    f"\n  Max depth: {td[0] or 0}"
                    f"\n  Root summaries: {td[1]}"
                    f"\n  Child summaries: {td[2]}"
                )

                cur.execute(
                    "SELECT (SELECT MAX(created_at) FROM ros_messages), "
                    "(SELECT MAX(created_at) FROM ros_summaries)"
                )
                f_row = cur.fetchone()
                newest_msg = time_since(f_row[0]) if f_row[0] else "never"
                newest_sum = time_since(f_row[1]) if f_row[1] else "never"
                sections.append(
                    f"\n**Freshness:**"
                    f"\n  Newest message: {newest_msg}"
                    f"\n  Newest summary: {newest_sum}"
                )
    except Exception as e:
        return f"Stats query failed: {e}"

    return "\n".join(sections)


# ---------------------------------------------------------------------------
# Dispatcher + prefetch formatter
# ---------------------------------------------------------------------------


class Tools:
    """Bundles the three tool handlers + prefetch formatter."""

    def __init__(self, client: RivetMemoryClient, engine: SearchEngine) -> None:
        self._client = client
        self._engine = engine
        self._expander = Expander(client)

    def dispatch(self, name: str, args: Dict[str, Any]) -> str:
        if name == "rivet_memory_search":
            return search_tool(self._engine, self._expander, args)
        if name == "rivet_memory_browse":
            return browse_tool(self._client, args)
        if name == "rivet_memory_stats":
            return stats_tool(self._client, args)
        return f"Unknown tool: {name}"

    def prefetch_block(
        self,
        query: str,
        *,
        limit: int = 10,
        mode: str = "fts",
    ) -> str:
        """Run a search + format hits as a ``<rivet-memory-context>`` block.

        Returns empty string on no hits — caller should skip injection in that
        case to avoid an empty container in the system prompt.
        """
        if not query.strip():
            return ""
        try:
            hits = self._engine.search(query, mode=mode, scope="both", limit=limit)
        except Exception as e:
            logger.debug("rivet_memory: prefetch search failed: %s", e)
            return ""
        if not hits:
            return ""

        lines = [f'<rivet-memory-context query="{_truncate(query, 80)}">']
        lines.append("## Recalled from RivetOS shared memory")
        for h in hits:
            age = _days_ago(h.created_at)
            tag = (
                f"[{h.kind or 'summary'}]" if h.type == "summary"
                else f"[{h.agent}/{h.role}]"
            )
            lines.append(
                f"- {tag} ({age}d ago, score {h.score:.3f}) {_truncate(h.content, 300)}"
            )
        lines.append("</rivet-memory-context>")
        return "\n".join(lines)
