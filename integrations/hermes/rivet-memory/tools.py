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
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

# Supported `window` enum values for browse + search shortcuts. The values
# compute a (since, before) UTC range from the server's local timezone so the
# caller doesn't have to do TZ math. "today" / "yesterday" / "this_morning"
# anchor to local midnight; "this_week" to local Monday; "last_24h" is a
# rolling 24h window from now; "last_7d" / "last_14d" are rolling multi-day
# ranges (prefer over this_week early in the week when calendar week is short).
WINDOW_CHOICES = (
    "today",
    "yesterday",
    "this_morning",
    "this_week",
    "last_24h",
    "last_7d",
    "last_14d",
)

# Free-form aliases agents invent → canonical WINDOW_CHOICES entry.
_WINDOW_ALIASES = {
    "last_week": "last_7d",
    "past_week": "last_7d",
    "last7d": "last_7d",
    "last_7_days": "last_7d",
    "past_7d": "last_7d",
    "last14d": "last_14d",
    "last_14_days": "last_14d",
    "past_14d": "last_14d",
    "last_two_weeks": "last_14d",
    "past_two_weeks": "last_14d",
    "last24h": "last_24h",
    "last_24_hours": "last_24h",
    "last_day": "last_24h",
}


def _format_window_choices() -> str:
    """Human-readable list of valid window= values for error messages."""
    return ", ".join(f'"{c}"' for c in WINDOW_CHOICES)


def _normalize_window(window: str) -> str:
    """Lower-case / snake_case cleanup + synonym map onto WINDOW_CHOICES."""
    s = window.strip().lower()
    if not s:
        return s
    s = (
        s.replace("last 24 hours", "last_24h")
        .replace("last 24h", "last_24h")
        .replace("last 7 days", "last_7d")
        .replace("last 14 days", "last_14d")
        .replace("past 7 days", "last_7d")
        .replace("past 14 days", "last_14d")
        .replace("last week", "last_7d")
        .replace("past week", "last_7d")
        .replace("last two weeks", "last_14d")
        .replace("this morning", "this_morning")
        .replace("this week", "this_week")
    )
    s = "_".join(s.replace("-", " ").split())
    return _WINDOW_ALIASES.get(s, s)


def resolve_window(window: str) -> Tuple[Optional[str], Optional[str]]:
    """Convert a window name to a (since_iso_utc, before_iso_utc) pair.

    All anchoring is done in the server's local timezone (the system TZ the
    Hermes process is running in), then converted to UTC. Returns ISO strings
    Postgres will parse via the usual timestamp coercion.

    Unknown values (after alias normalization) raise ``ValueError`` listing
    valid choices. Silent ``(None, None)`` was a daily-use footgun — agents
    thought they time-bounded but got unfiltered full history (parity with
    postgres tools hard-fail from #408).
    """
    window = _normalize_window(window)
    if not window:
        raise ValueError(
            f'Invalid window="" — expected one of: {_format_window_choices()}'
        )

    now_local = datetime.now().astimezone()
    today_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)

    if window == "today":
        return (today_local.astimezone(timezone.utc).isoformat(), None)
    if window == "yesterday":
        yest = today_local - timedelta(days=1)
        return (
            yest.astimezone(timezone.utc).isoformat(),
            today_local.astimezone(timezone.utc).isoformat(),
        )
    if window == "this_morning":
        # Same lower bound as today — "this morning" is just the morning
        # subset of today, but the agent will usually narrow the result set
        # itself; we don't try to define when morning ends.
        return (today_local.astimezone(timezone.utc).isoformat(), None)
    if window == "this_week":
        # ISO week — Monday is 0. weekday() returns 0=Mon..6=Sun.
        # On Mon/Tue this is almost empty — prefer last_7d for "recent work".
        monday = today_local - timedelta(days=today_local.weekday())
        return (monday.astimezone(timezone.utc).isoformat(), None)
    if window == "last_24h":
        return ((now_local - timedelta(hours=24)).astimezone(timezone.utc).isoformat(), None)
    if window == "last_7d":
        return ((now_local - timedelta(days=7)).astimezone(timezone.utc).isoformat(), None)
    if window == "last_14d":
        return ((now_local - timedelta(days=14)).astimezone(timezone.utc).isoformat(), None)
    raise ValueError(
        f'Unknown window="{window}" — expected one of: {_format_window_choices()}'
    )

from .client import RivetMemoryClient
from .expand import Expander, SourceMessage, SummaryNode
from .get_full import get_full_tool
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
    """UTC calendar date (legacy). Prefer fmt_local_date for agent-facing output."""
    if d is None:
        return "?"
    return _ensure_aware(d).date().isoformat()


def fmt_local_date(d: Optional[datetime]) -> str:
    """Local calendar date YYYY-MM-DD — avoids UTC day-boundary mislabels."""
    if d is None:
        return "?"
    return _ensure_aware(d).astimezone().date().isoformat()


def fmt_local_ts(d: datetime) -> str:
    """Local wall-clock with zone label (browse parity)."""
    ts_local = _ensure_aware(d).astimezone()
    return ts_local.strftime("%Y-%m-%d %H:%M:%S %Z").rstrip()


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


def fmt_hit_when(d: datetime) -> str:
    """Relative age + absolute local timestamp for search hit headers.

    Search used to emit only floor-day ages (``0d ago`` / ``3d ago``) with no
    absolute time — same-day hits looked timeless. Pairing relative + local-TZ
    absolute matches browse so agents can place hits on a real timeline.
    """
    return f"{time_since(d)} · {fmt_local_ts(d)}"


def _truncate(text: str, n: int) -> str:
    return text if len(text) <= n else text[:n] + "…"


def _truncation_hint(meta: Any, id_: str) -> str:
    """One-line marker appended to browse output when a row was truncated at
    capture time — carries the original length and the rivet_memory_get_full
    handle (issue #197, parity with @rivetos/memory-postgres). Empty string
    for complete rows."""
    if not isinstance(meta, dict) or meta.get("truncated") is not True:
        return ""
    full = meta.get("full_content_length")
    if full is None:
        full = meta.get("full_tool_result_length")
    is_num = isinstance(full, (int, float)) and not isinstance(full, bool)
    length = f"{full} chars" if is_num else "unknown length"
    return f"\n⚠ truncated at capture (full: {length}) → rivet_memory_get_full id={id_}"


# Display caps for browse rows (parity with @rivetos/memory-postgres helpers).
BROWSE_CONTENT_LIMIT = 500
BROWSE_TOOL_RESULT_LIMIT = 800


def _format_browse_message_body(
    id_: str,
    content: str,
    tool_name: Optional[str],
    tool_result: Optional[str],
    meta: Any,
    *,
    content_limit: int = BROWSE_CONTENT_LIMIT,
    tool_result_limit: int = BROWSE_TOOL_RESULT_LIMIT,
) -> str:
    """Format one browse row body: content + tool_result preview + recovery.

    Daily-use footgun: browse used to select only ``content``, so tool rows
    rendered as ``[tool] search_tool`` with no payload. When the stored row is
    complete (not capture-truncated), display cuts point at
    ``rivet_memory_get_full`` which returns the full DB payload.
    """
    capture_trunc = isinstance(meta, dict) and meta.get("truncated") is True
    parts: List[str] = []
    text = content or ""
    if len(text) > content_limit:
        parts.append(text[:content_limit] + "…")
        if not capture_trunc:
            parts.append(
                f"…[display-truncated content {len(text)} chars → "
                f"rivet_memory_get_full id={id_}]"
            )
    else:
        parts.append(text)

    if isinstance(tool_result, str) and tool_result:
        label = f"tool_result ({tool_name})" if tool_name else "tool_result"
        if len(tool_result) > tool_result_limit:
            parts.append(
                f"[{label} {len(tool_result)} chars]\n"
                f"{tool_result[:tool_result_limit]}…"
            )
            if not capture_trunc:
                parts.append(
                    f"…[display-truncated tool_result → "
                    f"rivet_memory_get_full id={id_}]"
                )
        else:
            parts.append(f"[{label}]\n{tool_result}")

    capture_hint = _truncation_hint(meta, id_)
    if capture_hint:
        parts.append(capture_hint.lstrip("\n"))

    return "\n".join(parts)


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


def _format_expanded(
    sections: List[str],
    expanded: List[_ExpandedSummary],
    all_summary_hits: List[SearchHit],
) -> None:
    sections.append("### Summaries (expanded)\n")
    for es in expanded:
        hit = es.hit
        when = fmt_hit_when(hit.created_at)
        if hit.earliest_at and hit.latest_at:
            period = f"{fmt_local_date(hit.earliest_at)} → {fmt_local_date(hit.latest_at)}"
        else:
            period = fmt_local_date(hit.created_at)
        sections.append(
            f"**[{hit.kind or 'summary'}]** ({when}, score: {hit.score:.3f}, "
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
                f"- [{hit.kind or 'summary'}] ({fmt_hit_when(hit.created_at)}, "
                f"score: {hit.score:.3f}) {_truncate(hit.content, 300)}"
            )
        sections.append("")


def _format_unexpanded(sections: List[str], summary_hits: List[SearchHit]) -> None:
    sections.append("### Summaries\n")
    for hit in summary_hits:
        sections.append(
            f"- [{hit.kind or 'summary'}/{hit.id}] ({fmt_hit_when(hit.created_at)}, "
            f"score: {hit.score:.3f}) {_truncate(hit.content, 300)}"
        )
    sections.append("")


def _format_messages(sections: List[str], message_hits: List[SearchHit]) -> None:
    sections.append("### Messages\n")
    for hit in message_hits:
        tool = f" [tool: {hit.tool_name}]" if hit.tool_name else ""
        # Include tool_result previews — content alone is often just
        # "[tool] name" (parity with postgres formatSearchMessageBody).
        body = _format_browse_message_body(
            hit.id,
            hit.content or "",
            hit.tool_name,
            hit.tool_result,
            None,
            content_limit=400,
            tool_result_limit=500,
        )
        sections.append(
            f"- [{hit.agent}/{hit.role}]{tool} ({fmt_hit_when(hit.created_at)}, "
            f"score: {hit.score:.3f})\n{body}"
        )


def search_tool(
    engine: SearchEngine,
    expander: Expander,
    args: Dict[str, Any],
) -> str:
    query = args.get("query", "")
    if not query:
        return "memory_search: `query` is required."

    mode = args.get("mode") or "hybrid"
    scope = args.get("scope") or "both"
    limit = max(1, min(int(args.get("limit") or 10), 50))
    agent = args.get("agent")
    since = args.get("since")
    before = args.get("before")
    # window= takes precedence when the caller hasn't supplied explicit
    # ISO bounds; the agent doesn't have to do local-TZ → UTC math.
    if args.get("window") and not (since or before):
        try:
            since, before = resolve_window(args["window"])
        except ValueError as exc:
            return f"Search failed: {exc}"
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
            f"trusting the empty result. For time-bounded questions (\"today\", "
            f"\"yesterday\", \"last week\"), prefer `rivet_memory_browse` with "
            f"window= — search ANDs the query with any date filter and returns "
            f"empty when FTS misses."
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
    since = args.get("since")
    before = args.get("before")
    if args.get("window") and not (since or before):
        try:
            since, before = resolve_window(args["window"])
        except ValueError as exc:
            return f"Browse failed: {exc}"
    if args.get("conversation_id"):
        conditions.append("m.conversation_id = %s")
        params.append(args["conversation_id"])
    if args.get("agent"):
        conditions.append("m.agent = %s")
        params.append(args["agent"])
    if since:
        conditions.append("m.created_at >= %s")
        params.append(since)
    if before:
        conditions.append("m.created_at < %s")
        params.append(before)

    limit = max(1, min(int(args.get("limit") or 50), 200))
    order_sql = "ASC" if args.get("order") == "asc" else "DESC"
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"""
        SELECT m.id, m.role, m.agent, m.content, m.created_at,
               m.conversation_id, m.tool_name, m.tool_result, m.metadata
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
        # Render timestamps in the server's local timezone with a TZ suffix
        # so readers can't mis-read UTC as local — that misread is exactly
        # what made a previous Hermes session report 00:10 UTC turns as
        # "early morning" when they were really 20:10 EDT yesterday.
        # Columns: id, role, agent, content, created_at, conversation_id,
        # tool_name, tool_result, metadata
        ts_local = _ensure_aware(r[4]).astimezone()
        ts = ts_local.strftime("%Y-%m-%d %H:%M:%S %Z").rstrip()
        tool = f" [tool: {r[6]}]" if r[6] else ""
        body = _format_browse_message_body(
            str(r[0]), r[3] or "", r[6], r[7], r[8]
        )
        lines.append(f"[{ts}] {r[2]}/{r[1]}{tool}\n{body}")

    direction = "newest" if order_sql == "DESC" else "oldest"
    header = f"## Messages ({len(rows)} returned, {direction} first)"
    if len(rows) >= limit:
        # Hit the cap — more rows may exist beyond this slice. Tell the agent
        # how to find them rather than silently truncating; for "what did we
        # do today?" the off-end chunk is usually what the user wants next.
        flip_order = "asc" if order_sql == "DESC" else "desc"
        hint = (
            f"\n_limit={limit} reached; more rows may exist beyond this slice. "
            f"Re-call with `order=\"{flip_order}\"` to see the other end, "
            f"raise `limit` (max 200), or narrow `since`/`before`/`window`._"
        )
        header += hint
    return header + "\n\n" + "\n\n---\n\n".join(lines)


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
        if name == "rivet_memory_get_full":
            return get_full_tool(self._client, args)
        return f"Unknown tool: {name}"

    def prefetch_block(
        self,
        query: str,
        *,
        limit: int = 10,
        mode: str = "hybrid",
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
            when = fmt_hit_when(h.created_at)
            tag = (
                f"[{h.kind or 'summary'}]" if h.type == "summary"
                else f"[{h.agent}/{h.role}]"
            )
            lines.append(
                f"- {tag} ({when}, score {h.score:.3f}) {_truncate(h.content, 300)}"
            )
        lines.append("</rivet-memory-context>")
        return "\n".join(lines)
