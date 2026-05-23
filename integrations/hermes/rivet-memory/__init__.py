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
        "Search RivetOS shared memory across every Rivet agent (rivet-claude, "
        "rivet-hermes, opus, grok). Hybrid FTS + semantic + temporal scoring "
        "with auto-expansion of summary hits to source messages. Use this to "
        "recall past decisions, prior context, or 'what did we say about X' "
        "before asking the user."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query — natural language question or keywords.",
            },
            "mode": {
                "type": "string",
                "enum": ["fts", "trigram", "regex"],
                "description": "fts (default), trigram (fuzzy), or regex (pattern).",
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
            "since": {"type": "string", "description": "ISO timestamp lower bound."},
            "before": {"type": "string", "description": "ISO timestamp upper bound."},
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
        "time order. Use to review what happened in a session or catch up on "
        "recent cross-agent activity."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "conversation_id": {"type": "string", "description": "Browse a specific conversation."},
            "since": {"type": "string", "description": "ISO timestamp lower bound."},
            "before": {"type": "string", "description": "ISO timestamp upper bound."},
            "agent": {"type": "string", "description": "Filter by agent."},
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 200,
                "description": "Max messages to return (default: 50).",
            },
            "order": {
                "type": "string",
                "enum": ["asc", "desc"],
                "description": "Chronological order (default: desc — newest first).",
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
            "(rivet-claude, rivet-hermes, opus, grok). Use `rivet_memory_search` "
            "to recall past decisions, commands, and context before asking the user."
        )

    # -- Recall --------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return any cached prefetch result. If no queue_prefetch has fired
        yet (first turn, or background thread hasn't completed), run inline."""
        if not self._recall_enabled or self._recall is None:
            return ""
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

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if not self._recall_enabled or self._recall is None:
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
