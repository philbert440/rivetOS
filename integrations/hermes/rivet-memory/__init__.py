"""RivetOS shared-memory provider plugin for Hermes.

Installs as ``$HERMES_HOME/plugins/rivet_memory/``. Captures Hermes turns,
memory-tool writes, delegations, and pre-compression messages into the
RivetOS memory database (cross-agent, shared with rivet-claude, opus, grok,
etc.) and exposes ``rivet_memory_search`` / ``rivet_memory_browse`` /
``rivet_memory_stats`` for recall.

The class ``RivetMemoryProvider`` is a top-level ``MemoryProvider`` subclass
— Hermes's loader auto-instantiates it (see
``plugins/memory/__init__.py:_load_provider_from_dir``).
"""

from __future__ import annotations

import logging
import os
import re
import threading
from typing import Any, Dict, List, Optional

try:
    from agent.memory_provider import MemoryProvider
except ImportError:  # outside Hermes — testing or lint context
    from abc import ABC

    class MemoryProvider(ABC):  # type: ignore[no-redef]
        """Stub used when ``agent.memory_provider`` isn't on sys.path.

        Hermes injects the real ABC at runtime; this stub keeps the package
        importable from tests and tooling.
        """


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool schemas — exposed via get_tool_schemas() so the model can call them.
# Names mirror the MCP server (memory_search, memory_browse, memory_stats) but
# are prefixed `rivet_` for the in-process surface so they don't collide with
# any other memory provider's tools.
# ---------------------------------------------------------------------------

SEARCH_SCHEMA = {
    "name": "rivet_memory_search",
    "description": (
        "Topic search over RivetOS shared memory across every Rivet agent "
        "(rivet-claude, rivet-hermes, opus, grok). Hybrid FTS + semantic + "
        "temporal scoring with auto-expansion of summary hits to source "
        "messages. **Requires a topic query** that maps to FTS-matchable "
        "tokens — empty/stopword queries return nothing even if rows exist in "
        "the window. For pure chronological browsing of a date window (\"what "
        "did we do this morning / yesterday / today\") use `rivet_memory_browse` "
        "instead — that's keyword-free and exhaustive."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "Topic to match against message/summary content (FTS "
                    "tokens). Required — `since`/`before` narrow this query, "
                    "they do not replace it."
                ),
            },
            "mode": {
                "type": "string",
                "enum": ["fts", "trigram", "regex"],
                "description": (
                    "fts (default) — websearch-syntax: ``foo bar`` is AND, "
                    "``foo OR bar`` is OR, ``\"exact phrase\"`` matches that "
                    "phrase, ``-noise`` excludes; blended with semantic when "
                    "an embedding endpoint is configured. trigram — fuzzy "
                    "/ literal tokens (IPs, MACs, error strings). regex — "
                    "PostgreSQL ``~*`` pattern."
                ),
            },
            "scope": {
                "type": "string",
                "enum": ["messages", "summaries", "both"],
                "description": "Where to search (default: both).",
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 50,
                "description": "Max top-level results (default: 10).",
            },
            "agent": {
                "type": "string",
                "description": "Filter by agent (e.g. rivet-hermes, rivet-claude, opus, grok).",
            },
            "since": {
                "type": "string",
                "description": (
                    "ISO timestamp lower bound. WARNING: a bare date "
                    "(`2026-05-23`) is interpreted as UTC midnight, NOT local "
                    "midnight — for users in EDT/PDT that's the previous "
                    "evening. Either pass an explicit UTC datetime "
                    "(`2026-05-23T04:00:00Z`) or use `window` and skip the TZ math."
                ),
            },
            "before": {
                "type": "string",
                "description": (
                    "ISO timestamp upper bound. Same UTC-midnight gotcha as "
                    "`since`. Prefer `window` for time-bounded queries."
                ),
            },
            "window": {
                "type": "string",
                "enum": ["today", "yesterday", "this_morning", "this_week", "last_24h"],
                "description": (
                    "Shortcut for time-bounded queries — resolves to a "
                    "(since, before) range in the SERVER'S LOCAL TIMEZONE, "
                    "no TZ math required. Overrides explicit since/before "
                    "only when neither is provided."
                ),
            },
            "expand": {
                "type": "boolean",
                "description": "Auto-expand top summary hits to source messages (default: true).",
            },
        },
        "required": ["query"],
    },
}

BROWSE_SCHEMA = {
    "name": "rivet_memory_browse",
    "description": (
        "Browse RivetOS conversation messages chronologically. Unlike "
        "rivet_memory_search (ranks by relevance), this returns messages in "
        "time order. Use for any time-bounded question (\"what did we do "
        "today / this morning / yesterday\") — pair with `window=...` for the "
        "right local-TZ-to-UTC math. If the response is truncated at `limit`, "
        "flip `order` to see the other end, raise `limit` (max 200), or "
        "narrow the window."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "conversation_id": {"type": "string", "description": "Browse a specific conversation."},
            "since": {
                "type": "string",
                "description": (
                    "ISO timestamp lower bound. WARNING: bare-date `2026-05-23` "
                    "is UTC midnight, not local midnight — for EDT/PDT users "
                    "that's the previous evening. Use `window` to avoid the TZ math."
                ),
            },
            "before": {
                "type": "string",
                "description": "ISO timestamp upper bound. Same UTC gotcha as `since`.",
            },
            "window": {
                "type": "string",
                "enum": ["today", "yesterday", "this_morning", "this_week", "last_24h"],
                "description": (
                    "Shortcut for time-bounded windows — resolves to (since, "
                    "before) in the SERVER'S LOCAL TIMEZONE, no TZ math "
                    "required. Overrides explicit since/before only when "
                    "neither is provided. Prefer this for \"today\" / "
                    "\"yesterday\" / \"this morning\" / \"this week\" / \"last 24h\"."
                ),
            },
            "agent": {"type": "string", "description": "Filter by agent."},
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "description": "Max messages to return (default: 50, max 200).",
            },
            "order": {
                "type": "string",
                "enum": ["asc", "desc"],
                "description": (
                    "Chronological order (default: desc — newest first). "
                    "For \"what did we do today?\" desc is usually right — "
                    "you'll see the most recent activity first."
                ),
            },
        },
        "required": [],
    },
}

STATS_SCHEMA = {
    "name": "rivet_memory_stats",
    "description": (
        "RivetOS memory health check — message/summary counts, embedding queue "
        "depth, compaction status. Use to diagnose memory issues or confirm "
        "background jobs are keeping up."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "agent": {"type": "string", "description": "Filter stats to a specific agent."},
        },
        "required": [],
    },
}

ALL_TOOL_SCHEMAS = [SEARCH_SCHEMA, BROWSE_SCHEMA, STATS_SCHEMA]


# ---------------------------------------------------------------------------
# Provider class
# ---------------------------------------------------------------------------

DEFAULT_AGENT = "rivet-hermes"
DEFAULT_CHANNEL_PREFIX = "hermes"
DEFAULT_RECALL_LIMIT = 10
DEFAULT_RECALL_MODE = "fts"
DEFAULT_EMBED_MODEL = "nemotron"

# Phrases that pin a time window. FTS-on-the-query for these returns
# relevance-ranked (not chronological) hits and is almost always stale noise
# — better to skip prefetch entirely and let the agent's own browse handle
# the window (the system_prompt_block + memory-recall skill point it there).
# Match as whole-word, case-insensitive.
_TIME_BOUNDED_PATTERN = re.compile(
    r"(?:^|\W)("
    r"this\s+(?:morning|afternoon|evening|week|month|year)"
    # today / todays / today's / yesterday / yesterdays / yesterday's / tomorrow(...)
    r"|today(?:['’]?s)?|yesterday(?:['’]?s)?|tomorrow(?:['’]?s)?"
    r"|earlier|recently|lately"
    r"|last\s+(?:night|week|month|year)"
    r"|the\s+other\s+day"
    r"|a?\s*(?:couple|few)\s+(?:of\s+)?(?:days|weeks|months|hours|minutes)\s+ago"
    r"|\d+\s+(?:days|weeks|months|hours|minutes)\s+ago"
    r"|since\s+(?:yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
    r")(?=\W|$)",
    re.IGNORECASE,
)


def _is_time_bounded(query: str) -> bool:
    return bool(query and _TIME_BOUNDED_PATTERN.search(query))


# Map a query's time cue to the best `window` enum value. Falls back to
# "today" when we matched a cue but can't pin it more precisely — the agent
# can always switch windows once it sees what's there.
_WINDOW_HINTS = (
    (re.compile(r"\bthis\s+morning\b", re.I), "this_morning"),
    (re.compile(r"(?:^|\W)yesterday(?:['’]?s)?(?=\W|$)", re.I), "yesterday"),
    (re.compile(r"\bthis\s+week\b|since\s+monday\b", re.I), "this_week"),
    (re.compile(r"\blast\s+(?:24\s*h|24\s*hours|day)\b", re.I), "last_24h"),
)


def _hint_window(query: str) -> str:
    for pat, win in _WINDOW_HINTS:
        if pat.search(query):
            return win
    return "today"


class RivetMemoryProvider(MemoryProvider):
    """Hermes memory provider backed by the RivetOS shared Postgres store."""

    def __init__(self) -> None:
        self._pg_url: str = ""
        self._agent: str = DEFAULT_AGENT
        self._channel_prefix: str = DEFAULT_CHANNEL_PREFIX
        self._channel: str = f"{DEFAULT_CHANNEL_PREFIX}-cli"
        self._recall_enabled: bool = True
        self._recall_limit: int = DEFAULT_RECALL_LIMIT
        self._recall_mode: str = DEFAULT_RECALL_MODE
        self._mirror_memory_md: bool = True
        self._preserve_compressed: bool = True
        self._embed_endpoint: str = ""
        self._embed_model: str = DEFAULT_EMBED_MODEL

        self._session_id: str = ""
        self._session_key: str = ""
        self._conversation_id: Optional[str] = None
        self._parent_session_id: str = ""
        self._platform: str = "cli"
        self._hermes_home: str = ""

        # Lazy imports — these touch psycopg / our own client.py only after
        # is_available() returns True and initialize() is called.
        self._client = None  # rivet_memory.client.RivetMemoryClient
        self._capture = None  # rivet_memory.capture.Capture
        self._recall = None  # rivet_memory.recall.Recall

        self._prefetch_lock = threading.Lock()
        self._prefetch_result: str = ""

    # -- Identity ------------------------------------------------------------

    @property
    def name(self) -> str:
        return "rivet_memory"

    # -- Availability --------------------------------------------------------

    def is_available(self) -> bool:
        """True iff we have a PG URL configured (env or config). No network calls."""
        if self._pg_url:
            return True
        if os.environ.get("RIVETOS_PG_URL"):
            return True
        try:
            from hermes_cli.config import load_config, cfg_get

            cfg = load_config()
            if cfg_get(cfg, "memory", "rivet_memory", "pg_url"):
                return True
        except Exception:
            pass
        return False

    # -- Config schema (drives `hermes memory setup`) ------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "pg_url",
                "description": "Postgres URL of the RivetOS memory database",
                "secret": True,
                "required": True,
                "env_var": "RIVETOS_PG_URL",
            },
            {
                "key": "agent",
                "description": "Agent tag written to every row",
                "default": DEFAULT_AGENT,
            },
            {
                "key": "channel_prefix",
                "description": "Channel prefix (suffixed with platform at runtime)",
                "default": DEFAULT_CHANNEL_PREFIX,
            },
            {
                "key": "recall_enabled",
                "description": "Inject recalled context before each turn",
                "default": True,
            },
            {
                "key": "recall_limit",
                "description": "Max hits returned per prefetch (1–50)",
                "default": DEFAULT_RECALL_LIMIT,
            },
            {
                "key": "recall_mode",
                "description": "Search mode for prefetch",
                "default": DEFAULT_RECALL_MODE,
                "choices": ["fts", "trigram", "hybrid"],
            },
            {
                "key": "mirror_memory_md",
                "description": "Mirror Hermes MEMORY.md / USER.md writes into RivetOS",
                "default": True,
            },
            {
                "key": "preserve_compressed",
                "description": "Capture pre-compression messages before they're discarded",
                "default": True,
            },
            {
                "key": "embed_endpoint",
                "description": "Embedding service URL (enables hybrid semantic scoring)",
                "secret": False,
                "env_var": "RIVETOS_EMBED_URL",
            },
            {
                "key": "embed_model",
                "description": "Embedding model name",
                "default": DEFAULT_EMBED_MODEL,
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        """Persist non-secret config to ~/.hermes/config.yaml under memory.rivet_memory.*."""
        import yaml
        from pathlib import Path

        cfg_path = Path(hermes_home) / "config.yaml"
        cfg: Dict[str, Any] = {}
        if cfg_path.exists():
            with open(cfg_path, encoding="utf-8") as fh:
                cfg = yaml.safe_load(fh) or {}
        memory = cfg.setdefault("memory", {})
        ours = memory.setdefault("rivet_memory", {})
        for k, v in values.items():
            ours[k] = v
        with open(cfg_path, "w", encoding="utf-8") as fh:
            yaml.safe_dump(cfg, fh, sort_keys=False)

    # -- Lifecycle -----------------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        self._session_key = f"hermes:{session_id}"
        self._hermes_home = kwargs.get("hermes_home", "")
        self._platform = kwargs.get("platform", "cli")
        self._channel = f"{self._channel_prefix}-{self._platform}"
        self._load_runtime_config()

        if not self._pg_url:
            logger.warning(
                "rivet_memory: no RIVETOS_PG_URL configured; capture/recall disabled"
            )
            return

        try:
            from .client import RivetMemoryClient
            from .capture import Capture
            from .recall import SearchEngine
            from .tools import Tools

            self._client = RivetMemoryClient(self._pg_url)
            self._capture = Capture(self._client, self._context_snapshot)
            engine = SearchEngine(
                self._client,
                embed_endpoint=self._embed_endpoint or None,
                embed_model=self._embed_model,
            )
            self._recall = Tools(self._client, engine)
        except Exception as e:
            logger.warning("rivet_memory: failed to initialize client/capture/recall: %s", e)
            self._client = None
            self._capture = None
            self._recall = None

    def _context_snapshot(self) -> tuple[str, str, str]:
        """Return live (session_key, agent, channel) for the capture worker."""
        return (self._session_key, self._agent, self._channel)

    def _load_runtime_config(self) -> None:
        """Pull config out of hermes_cli.config + env vars."""
        try:
            from hermes_cli.config import load_config, cfg_get

            cfg = load_config()
        except Exception:
            cfg = {}

        def _get(key: str, default: Any) -> Any:
            try:
                v = cfg_get(cfg, "memory", "rivet_memory", key)
            except Exception:
                v = None
            return v if v is not None else default

        self._pg_url = (
            os.environ.get("RIVETOS_PG_URL")
            or _get("pg_url", "")
        )
        self._agent = _get("agent", DEFAULT_AGENT)
        self._channel_prefix = _get("channel_prefix", DEFAULT_CHANNEL_PREFIX)
        self._channel = f"{self._channel_prefix}-{self._platform}"
        self._recall_enabled = bool(_get("recall_enabled", True))
        self._recall_limit = int(_get("recall_limit", DEFAULT_RECALL_LIMIT))
        self._recall_mode = str(_get("recall_mode", DEFAULT_RECALL_MODE))
        self._mirror_memory_md = bool(_get("mirror_memory_md", True))
        self._preserve_compressed = bool(_get("preserve_compressed", True))
        self._embed_endpoint = (
            os.environ.get("RIVETOS_EMBED_URL")
            or _get("embed_endpoint", "")
        )
        self._embed_model = _get("embed_model", DEFAULT_EMBED_MODEL)

    def shutdown(self) -> None:
        if self._capture is not None:
            try:
                self._capture.shutdown(timeout=5.0)
            except Exception as e:
                logger.debug("rivet_memory: capture shutdown failed: %s", e)
        if self._client is not None:
            try:
                self._client.close()
            except Exception as e:
                logger.debug("rivet_memory: client close on shutdown failed: %s", e)

    # -- System prompt -------------------------------------------------------

    def system_prompt_block(self) -> str:
        if not self._recall_enabled:
            return ""
        return (
            "You have access to RivetOS shared memory across every Rivet agent "
            "(rivet-claude, rivet-hermes, opus, grok). Three tools:\n"
            "  - `rivet_memory_browse` — chronological; use FIRST for any "
            "time-bounded question (\"this morning\", \"yesterday\", \"last week\").\n"
            "  - `rivet_memory_search` — relevance-ranked FTS + semantic; use for "
            "topic questions, run THREE queries from different angles "
            "(service / host / subnet / role) before trusting an empty result. "
            "Fall back to `mode: \"trigram\"` for literal tokens (IPs, MACs, "
            "exact error strings).\n"
            "  - `rivet_memory_stats` — system health.\n"
            "Full discipline lives in the `memory-recall` skill; auto-loads on "
            "recall cues. Hits may carry any Rivet agent's tag — treat them as "
            "first-class unless the user explicitly means \"this Hermes session.\""
        )

    # -- Recall --------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return any cached prefetch result. If no queue_prefetch has fired
        yet (first turn, or background thread hasn't completed), run inline.

        Time-bounded queries ("today", "yesterday", "this morning", ...) skip
        the FTS prefetch and instead inject a one-line hint pointing at
        ``rivet_memory_browse(window=...)``. Relevance-ranked FTS returns
        stale hits for these queries; the hint gets the agent to the right
        tool without burning a turn.
        """
        if not self._recall_enabled or self._recall is None:
            return ""
        if _is_time_bounded(query):
            with self._prefetch_lock:
                self._prefetch_result = ""
            return self._time_bounded_hint(query)
        with self._prefetch_lock:
            cached = self._prefetch_result
            self._prefetch_result = ""
        if cached:
            return cached
        try:
            return self._recall.prefetch_block(
                query, limit=self._recall_limit, mode=self._recall_mode
            )
        except Exception as e:
            logger.debug("rivet_memory: inline prefetch failed: %s", e)
            return ""

    def _time_bounded_hint(self, query: str) -> str:
        """Tiny <rivet-memory-context> block telling the agent which browse
        call to make. Cheaper than a real prefetch and aligned with the
        discipline skill."""
        win = _hint_window(query)
        return (
            f'<rivet-memory-context query="{query[:80]}">\n'
            f"This question looks time-bounded. Skip search — call "
            f"`rivet_memory_browse(window=\"{win}\")` to scan the window in "
            f"the server's local timezone (no manual UTC math). If the "
            f"response is truncated, flip `order=\"asc\"` to see the other "
            f"end or raise `limit`.\n"
            f"</rivet-memory-context>"
        )

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if not self._recall_enabled or self._recall is None:
            return
        if _is_time_bounded(query):
            # Skip the background DB hit; the hint is emitted from prefetch().
            with self._prefetch_lock:
                self._prefetch_result = ""
            return

        def _run() -> None:
            try:
                block = self._recall.prefetch_block(
                    query, limit=self._recall_limit, mode=self._recall_mode
                )
            except Exception as e:
                logger.debug("rivet_memory: background prefetch failed: %s", e)
                return
            with self._prefetch_lock:
                self._prefetch_result = block

        threading.Thread(
            target=_run, name="rivet-memory-prefetch", daemon=True
        ).start()

    # -- Capture -------------------------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        if self._capture is None:
            return
        self._capture.ingest_turn(user_content, assistant_content)

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if self._capture is None or not self._mirror_memory_md:
            return
        self._capture.ingest_memory_write(action, target, content, metadata)

    def on_delegation(
        self, task: str, result: str, *, child_session_id: str = "", **kwargs
    ) -> None:
        if self._capture is None:
            return
        # Surface any extra kwargs (model, platform, etc.) as metadata extras.
        self._capture.ingest_delegation(task, result, child_session_id, extra=dict(kwargs))

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        if self._capture is None or not self._preserve_compressed:
            return ""
        self._capture.ingest_compressed(messages)
        return "Pre-compression messages preserved in RivetOS shared memory."

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        **kwargs,
    ) -> None:
        old_key = self._session_key
        if reset and self._capture is not None and old_key:
            # Close the old conversation in the background; the next write
            # under the new session_key spawns a fresh one via ensure_conversation.
            self._capture.close_session(old_key)
        self._session_id = new_session_id
        self._session_key = f"hermes:{new_session_id}"
        # For reset=False, mint a parent-link breadcrumb on the next memory_write
        # caller by exposing the parent id; capture metadata will include it
        # naturally on subsequent on_memory_write / on_delegation events.
        self._parent_session_id = parent_session_id

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        if self._capture is not None and self._session_key:
            self._capture.close_session(self._session_key)
        self.shutdown()

    # -- Tool surface --------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return ALL_TOOL_SCHEMAS

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        import json

        if self._recall is None:
            return json.dumps({"error": "rivet_memory not initialized"})
        try:
            text = self._recall.dispatch(tool_name, args)
        except Exception as e:
            return json.dumps({"error": f"tool {tool_name} failed: {e}"})
        # Hermes contract: handle_tool_call returns a JSON string. Wrap markdown
        # in a single-key object so callers always get parseable JSON.
        return json.dumps({"text": text})
