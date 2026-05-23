"""Background-thread capture queue.

Hermes hooks are called inline on the per-turn hot path and the contract
says writes ``should be non-blocking — queue for background processing if the
backend has latency`` (agent/memory_provider.py:``sync_turn``).

This module owns one daemon worker thread per provider instance. Each capture
hook enqueues a small op tuple; the worker drains the queue and writes via
``RivetMemoryClient``. Errors are logged and swallowed — the agent must never
stall because RivetOS is unreachable.

Only ``ingest_turn`` is wired in this first pass; the other hooks land in a
follow-up task (see ``__init__.py`` for the call sites).
"""

from __future__ import annotations

# See ``tools.py`` for the rationale behind this namespace bootstrap.
import sys as _sys
import types as _types

_top = __name__.split(".", 1)[0]
if _top.startswith("_") and _top not in _sys.modules:
    _sys.modules[_top] = _types.ModuleType(_top)

import logging
import queue
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import schema as S
from .client import RivetMemoryClient

logger = logging.getLogger(__name__)

# Sentinel pushed into the queue at shutdown to release the worker.
_STOP = object()

# Op shapes — each tuple's first element is the kind.
#   ('turn', user_content, assistant_content)
#   ('memory_write', action, target, content, metadata)
#   ('delegation', task, result, child_session_id)
#   ('compressed', [{role, content, ...}, ...])
#   ('close_conversation', conversation_id)


# Context callable returns the live (session_key, agent, channel) at write
# time, so on_session_switch can rotate values without rebuilding the worker.
ContextFn = Callable[[], Tuple[str, str, str]]


class Capture:
    def __init__(
        self,
        client: RivetMemoryClient,
        context_fn: ContextFn,
        *,
        max_queue_size: int = 0,  # 0 == unbounded; sized lists if Hermes ever bursts
    ) -> None:
        self._client = client
        self._context_fn = context_fn
        self._queue: queue.Queue = queue.Queue(maxsize=max_queue_size)
        self._stop = threading.Event()
        self._worker = threading.Thread(
            target=self._run,
            name="rivet-memory-capture",
            daemon=True,
        )
        self._worker.start()

    # -- Public hook surface -------------------------------------------------

    def ingest_turn(self, user_content: str, assistant_content: str) -> None:
        # Allow either side to be empty (tool-only turns, system warmups, etc.).
        self._queue.put(("turn", user_content or "", assistant_content or ""))

    def ingest_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._queue.put(("memory_write", action, target, content or "", dict(metadata or {})))

    def ingest_delegation(
        self,
        task: str,
        result: str,
        child_session_id: str = "",
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._queue.put(
            ("delegation", task or "", result or "", child_session_id or "", dict(extra or {}))
        )

    def ingest_compressed(self, messages: List[Dict[str, Any]]) -> None:
        if not messages:
            return
        self._queue.put(("compressed", list(messages)))

    def close_session(self, session_key: str) -> None:
        """Enqueue an inactive-mark for a session_key. Used by reset/end paths."""
        self._queue.put(("close_session", session_key))

    # -- Lifecycle -----------------------------------------------------------

    def flush(self, timeout: float = 5.0) -> bool:
        """Block until the queue drains or ``timeout`` elapses.

        Returns True on clean drain, False on timeout. ``queue.Queue`` ships
        no join-with-timeout, so poll.
        """
        import time

        deadline = time.monotonic() + timeout
        while not self._queue.empty():
            if time.monotonic() > deadline:
                return False
            time.sleep(0.05)
        return True

    def shutdown(self, timeout: float = 5.0) -> None:
        self._stop.set()
        # Push the sentinel so .get() in the worker returns promptly.
        try:
            self._queue.put_nowait(_STOP)
        except queue.Full:
            # Bounded queue full — flush then push.
            self.flush(timeout=timeout)
            self._queue.put_nowait(_STOP)
        self._worker.join(timeout=timeout)

    # -- Worker --------------------------------------------------------------

    def _run(self) -> None:
        while True:
            op = self._queue.get()
            if op is _STOP:
                return
            try:
                self._dispatch(op)
            except Exception as e:
                logger.warning("rivet_memory: capture op %r failed: %s", op[:1] if op else op, e)

    # -- Dispatch ------------------------------------------------------------

    def _dispatch(self, op: Tuple[Any, ...]) -> None:
        kind = op[0]
        session_key, agent, channel = self._context_fn()

        if kind == "turn":
            _, user, asst = op
            if user:
                self._client.append_message(
                    session_key=session_key,
                    agent=agent,
                    channel=channel,
                    role=S.ROLE_USER,
                    content=user,
                )
            if asst:
                self._client.append_message(
                    session_key=session_key,
                    agent=agent,
                    channel=channel,
                    role=S.ROLE_ASSISTANT,
                    content=asst,
                )
            return

        if kind == "memory_write":
            _, action, target, content, metadata = op
            meta = {"source": "hermes-memory-tool", "action": action, "target": target}
            meta.update(metadata)
            self._client.append_message(
                session_key=session_key,
                agent=agent,
                channel=channel,
                role=S.ROLE_SYSTEM,
                content=content,
                metadata=meta,
            )
            return

        if kind == "delegation":
            _, task, result, child_session_id, extra = op
            meta = {"kind": "delegation", "child_session_id": child_session_id}
            meta.update(extra)
            # One row per delegation observation. Layout the task + result so
            # FTS can hit either side.
            body = f"[delegation] task:\n{task}\n\n[delegation] result:\n{result}"
            self._client.append_message(
                session_key=session_key,
                agent=agent,
                channel=channel,
                role=S.ROLE_SYSTEM,
                content=body,
                metadata=meta,
            )
            return

        if kind == "compressed":
            _, messages = op
            # Bulk insert under the active conversation, tagged so anyone
            # searching can tell these were preserved from a compression event.
            rows = []
            for m in messages:
                role = m.get("role")
                if role not in S.VALID_ROLES:
                    continue
                rows.append(
                    {
                        "role": role,
                        "content": m.get("content") or "",
                        "tool_name": m.get("tool_name"),
                        "tool_args": m.get("tool_args"),
                        "tool_result": m.get("tool_result"),
                        "metadata": {
                            "preserved_from": "pre-compress",
                            **(m.get("metadata") or {}),
                        },
                    }
                )
            if rows:
                self._client.append_many(
                    rows,
                    session_key=session_key,
                    agent=agent,
                    channel=channel,
                )
            return

        if kind == "close_session":
            _, target_key = op
            self._client.close_by_session_key(target_key, agent)
            return

        logger.debug("rivet_memory: dispatch received unimplemented kind %r", kind)
