"""SearchEngine — hybrid FTS + semantic + temporal + importance scoring.

Direct port of ``plugins/memory/postgres/src/search.ts``. Three modes:

- ``fts``     — ``websearch_to_tsquery`` + ``ts_rank_cd``; if an embedding endpoint
                is configured, the query is embedded at search time and blended
                with the FTS score via real cosine similarity on ``halfvec``.
                ``websearch_to_tsquery`` honors ``OR`` (case-insensitive),
                phrase quoting, and ``-NOT``, so natural-language queries
                like ``today OR daily OR session`` behave as the caller
                expects instead of silently AND-ing every token (the
                ``plainto_tsquery`` behavior that caused PR #192's
                first real-session miss).
- ``trigram`` — ``pg_trgm`` similarity (fuzzy / typo-tolerant)
- ``regex``   — PostgreSQL ``~*``

Falls back to a length-based semantic proxy when no query embedding is
available so a row missing FTS evidence still scores something.

Access counts on returned rows are bumped fire-and-forget so the temporal
component rewards frequent recall (Ebbinghaus reinforcement).
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
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import List, Literal, Optional

from .client import RivetMemoryClient
from .scoring import (
    SUMMARY_IMPORTANCE,
    W_FTS,
    W_IMPORTANCE,
    W_SEMANTIC,
    W_TEMPORAL,
    importance_sql,
    temporal_decay_sql,
)

logger = logging.getLogger(__name__)

EMBED_TIMEOUT_S = 5.0

# pgvector halfvec column is 4000 dims; nemotron returns 4096 natively. Embedding
# worker truncates stored rows the same way, so query-side must match.
EMBED_DIMS = 4000

SearchMode = Literal["fts", "trigram", "regex"]
SearchScope = Literal["messages", "summaries", "both"]


@dataclass
class SearchHit:
    id: str
    type: Literal["message", "summary"]
    content: str
    role: str
    agent: str
    conversation_id: str
    score: float
    created_at: datetime
    kind: Optional[str] = None
    earliest_at: Optional[datetime] = None
    latest_at: Optional[datetime] = None


def _semantic_proxy(alias: str) -> str:
    """Length-based fallback when no query embedding is available."""
    return f"LEAST(LENGTH({alias}.content) / 1000.0, 1.0)"


def _vec_literal(embedding: List[float]) -> str:
    """Render a Python list as a pgvector text literal."""
    return "[" + ",".join(f"{v:.6f}" for v in embedding) + "]"


class SearchEngine:
    def __init__(
        self,
        client: RivetMemoryClient,
        *,
        embed_endpoint: Optional[str] = None,
        embed_model: str = "nemotron",
    ) -> None:
        self._client = client
        self._embed_endpoint = embed_endpoint
        self._embed_model = embed_model

    # -- Public surface ------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        mode: SearchMode = "fts",
        scope: SearchScope = "both",
        limit: int = 20,
        agent: Optional[str] = None,
        since: Optional[str] = None,
        before: Optional[str] = None,
    ) -> List[SearchHit]:
        query_embedding: Optional[List[float]] = None
        if mode == "fts" and self._embed_endpoint:
            query_embedding = self._embed_query(query)

        results: List[SearchHit] = []
        if scope in ("messages", "both"):
            results.extend(
                self._search_messages(
                    query, mode, limit, agent, since, before, query_embedding
                )
            )
        if scope in ("summaries", "both"):
            results.extend(
                self._search_summaries(query, mode, limit, since, before, query_embedding)
            )

        results.sort(key=lambda h: h.score, reverse=True)
        top = results[:limit]
        # Bump access counts in the background — never block on it.
        threading.Thread(
            target=self._bump_access,
            args=(top,),
            name="rivet-memory-bump-access",
            daemon=True,
        ).start()
        return top

    def vector_search(
        self,
        embedding: List[float],
        *,
        scope: SearchScope = "both",
        limit: int = 10,
        agent: Optional[str] = None,
    ) -> List[SearchHit]:
        if len(embedding) > EMBED_DIMS:
            embedding = embedding[:EMBED_DIMS]
        vec = _vec_literal(embedding)

        results: List[SearchHit] = []
        if scope in ("messages", "both"):
            temporal = temporal_decay_sql("m")
            imp = importance_sql("m")
            agent_clause = "AND m.agent = %s" if agent else ""
            params: list = []
            sql = f"""
                SELECT m.id, m.content, m.role, m.agent,
                       m.conversation_id, m.created_at,
                       (
                         (1 - (m.embedding <=> '{vec}'::halfvec)) * {W_SEMANTIC}
                         + ({temporal}) * {W_TEMPORAL}
                         + ({imp}) * {W_IMPORTANCE}
                       ) AS score
                  FROM ros_messages m
                 WHERE m.embedding IS NOT NULL {agent_clause}
                 ORDER BY m.embedding <=> '{vec}'::halfvec
                 LIMIT %s
            """
            if agent:
                params.append(agent)
            params.append(limit)
            with self._client.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    rows = cur.fetchall()
            for r in rows:
                results.append(
                    SearchHit(
                        id=str(r[0]),
                        type="message",
                        content=r[1] or "",
                        role=r[2],
                        agent=r[3],
                        conversation_id=str(r[4]),
                        score=float(r[6]),
                        created_at=r[5],
                    )
                )

        if scope in ("summaries", "both"):
            temporal = temporal_decay_sql("s")
            sql = f"""
                SELECT s.id, s.content, s.kind, 'summary' AS agent,
                       s.conversation_id, s.created_at,
                       s.kind, s.earliest_at, s.latest_at,
                       (
                         (1 - (s.embedding <=> '{vec}'::halfvec)) * {W_SEMANTIC}
                         + ({temporal}) * {W_TEMPORAL}
                         + {SUMMARY_IMPORTANCE} * {W_IMPORTANCE}
                       ) AS score
                  FROM ros_summaries s
                 WHERE s.embedding IS NOT NULL
                 ORDER BY s.embedding <=> '{vec}'::halfvec
                 LIMIT %s
            """
            with self._client.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, (limit,))
                    rows = cur.fetchall()
            for r in rows:
                results.append(
                    SearchHit(
                        id=str(r[0]),
                        type="summary",
                        content=r[1] or "",
                        role=r[2],
                        agent=r[3],
                        conversation_id=str(r[4]) if r[4] is not None else "",
                        score=float(r[9]),
                        created_at=r[5],
                        kind=r[6],
                        earliest_at=r[7],
                        latest_at=r[8],
                    )
                )

        results.sort(key=lambda h: h.score, reverse=True)
        top = results[:limit]
        threading.Thread(
            target=self._bump_access,
            args=(top,),
            name="rivet-memory-bump-access",
            daemon=True,
        ).start()
        return top

    # -- Internal: query embedding ------------------------------------------

    def _embed_query(self, text: str) -> Optional[List[float]]:
        if not self._embed_endpoint:
            return None
        url = self._embed_endpoint.rstrip("/") + "/v1/embeddings"
        body = json.dumps(
            {"input": [text[:8000]], "model": self._embed_model}
        ).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=EMBED_TIMEOUT_S) as resp:
                if resp.status != 200:
                    logger.warning(
                        "rivet_memory: embedding endpoint returned HTTP %s", resp.status
                    )
                    return None
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            logger.warning("rivet_memory: embedding endpoint unreachable: %s", e)
            return None
        except Exception as e:
            logger.warning("rivet_memory: embedding call failed: %s", e)
            return None

        try:
            vec = payload["data"][0]["embedding"]
        except (KeyError, IndexError, TypeError):
            logger.warning("rivet_memory: embedding response missing data[0].embedding")
            return None
        if not isinstance(vec, list) or not vec:
            return None
        if len(vec) > EMBED_DIMS:
            vec = vec[:EMBED_DIMS]
        return [float(v) for v in vec]

    # -- Internal: message search -------------------------------------------

    def _search_messages(
        self,
        query: str,
        mode: SearchMode,
        limit: int,
        agent: Optional[str],
        since: Optional[str],
        before: Optional[str],
        query_embedding: Optional[List[float]],
    ) -> List[SearchHit]:
        # Separate SELECT-clause params from WHERE-clause params — psycopg
        # binds %s positionally in the order they appear in the final SQL
        # string. The SELECT expression is rendered before the WHERE clause,
        # so any %s inside the score expression must come first in the param
        # list.
        select_params: list = []
        conditions: List[str] = []
        condition_params: list = []

        if mode == "fts":
            fts_expr = "ts_rank_cd(m.content_tsv, websearch_to_tsquery('english', %s))"
            select_params.append(query)
            conditions.append("m.content_tsv @@ websearch_to_tsquery('english', %s)")
            condition_params.append(query)
        elif mode == "trigram":
            fts_expr = "similarity(m.content, %s)"
            select_params.append(query)
            conditions.append("similarity(m.content, %s) > 0.3")
            condition_params.append(query)
        elif mode == "regex":
            fts_expr = "1.0"
            conditions.append("m.content ~* %s")
            condition_params.append(query)
        else:
            raise ValueError(f"unknown search mode: {mode!r}")

        if agent:
            conditions.append("m.agent = %s")
            condition_params.append(agent)
        if since:
            conditions.append("m.created_at >= %s")
            condition_params.append(since)
        if before:
            conditions.append("m.created_at < %s")
            condition_params.append(before)

        if mode == "fts" and query_embedding is not None:
            vec = _vec_literal(query_embedding)
            semantic_expr = (
                f"COALESCE(1 - (m.embedding <=> '{vec}'::halfvec), "
                f"{_semantic_proxy('m')})"
            )
        else:
            semantic_expr = _semantic_proxy("m")

        temporal = temporal_decay_sql("m")
        imp = importance_sql("m")
        where = " AND ".join(conditions)
        sql = f"""
            SELECT m.id, m.content, m.role, m.agent, m.conversation_id, m.created_at,
                   (
                     {fts_expr} * {W_FTS}
                     + {semantic_expr} * {W_SEMANTIC}
                     + ({temporal}) * {W_TEMPORAL}
                     + ({imp}) * {W_IMPORTANCE}
                   ) AS score
              FROM ros_messages m
             WHERE {where}
             ORDER BY score DESC
             LIMIT %s
        """
        params = select_params + condition_params + [limit]

        with self._client.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()

        return [
            SearchHit(
                id=str(r[0]),
                type="message",
                content=r[1] or "",
                role=r[2],
                agent=r[3],
                conversation_id=str(r[4]),
                score=float(r[6]),
                created_at=r[5],
            )
            for r in rows
        ]

    # -- Internal: summary search -------------------------------------------

    def _search_summaries(
        self,
        query: str,
        mode: SearchMode,
        limit: int,
        since: Optional[str],
        before: Optional[str],
        query_embedding: Optional[List[float]],
    ) -> List[SearchHit]:
        # SELECT-clause params first (see _search_messages for the rationale).
        select_params: list = []
        conditions: List[str] = []
        condition_params: list = []

        if mode == "fts":
            fts_expr = "ts_rank_cd(s.content_tsv, websearch_to_tsquery('english', %s))"
            select_params.append(query)
            conditions.append("s.content_tsv @@ websearch_to_tsquery('english', %s)")
            condition_params.append(query)
        elif mode == "trigram":
            fts_expr = "similarity(s.content, %s)"
            select_params.append(query)
            conditions.append("similarity(s.content, %s) > 0.3")
            condition_params.append(query)
        elif mode == "regex":
            fts_expr = "1.0"
            conditions.append("s.content ~* %s")
            condition_params.append(query)
        else:
            raise ValueError(f"unknown search mode: {mode!r}")

        if since:
            conditions.append("s.created_at >= %s")
            condition_params.append(since)
        if before:
            conditions.append("s.created_at < %s")
            condition_params.append(before)

        if mode == "fts" and query_embedding is not None:
            vec = _vec_literal(query_embedding)
            semantic_expr = (
                f"COALESCE(1 - (s.embedding <=> '{vec}'::halfvec), "
                f"{_semantic_proxy('s')})"
            )
        else:
            semantic_expr = _semantic_proxy("s")

        temporal = temporal_decay_sql("s")
        where = " AND ".join(conditions)
        sql = f"""
            SELECT s.id, s.content, s.kind, 'summary' AS agent,
                   s.conversation_id, s.created_at,
                   s.kind, s.earliest_at, s.latest_at,
                   (
                     {fts_expr} * {W_FTS}
                     + {semantic_expr} * {W_SEMANTIC}
                     + ({temporal}) * {W_TEMPORAL}
                     + {SUMMARY_IMPORTANCE} * {W_IMPORTANCE}
                   ) AS score
              FROM ros_summaries s
             WHERE {where}
             ORDER BY score DESC
             LIMIT %s
        """
        params = select_params + condition_params + [limit]

        with self._client.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()

        return [
            SearchHit(
                id=str(r[0]),
                type="summary",
                content=r[1] or "",
                role=r[2],
                agent=r[3],
                conversation_id=str(r[4]) if r[4] is not None else "",
                score=float(r[9]),
                created_at=r[5],
                kind=r[6],
                earliest_at=r[7],
                latest_at=r[8],
            )
            for r in rows
        ]

    # -- Internal: access reinforcement -------------------------------------

    def _bump_access(self, hits: List[SearchHit]) -> None:
        msg_ids = [h.id for h in hits if h.type == "message"]
        sum_ids = [h.id for h in hits if h.type == "summary"]
        try:
            with self._client.connection() as conn:
                with conn.cursor() as cur:
                    if msg_ids:
                        cur.execute(
                            """
                            UPDATE ros_messages
                               SET access_count = access_count + 1,
                                   last_accessed_at = NOW()
                             WHERE id = ANY(%s::uuid[])
                            """,
                            (msg_ids,),
                        )
                    if sum_ids:
                        cur.execute(
                            """
                            UPDATE ros_summaries
                               SET access_count = access_count + 1,
                                   last_accessed_at = NOW()
                             WHERE id = ANY(%s::uuid[])
                            """,
                            (sum_ids,),
                        )
                conn.commit()
        except Exception as e:
            logger.debug("rivet_memory: bump_access failed: %s", e)
