"""SearchEngine — hybrid retrieval over the RivetOS memory store.

Direct port of ``plugins/memory/postgres/src/search.ts``. Default mode
``hybrid`` fuses three independent retrievers — FTS, trigram, and vector (ANN
over the HNSW index) — with Reciprocal Rank Fusion, then a gentle
recency/importance boost. This makes recall robust to how any single method
fails: FTS tokenization mangles literal/dotted terms (domains, IPs, model ids),
trigram is blind to meaning, and vector misses exact tokens. Fusing them means a
hit any one method finds survives.

Explicit modes are deliberate escape hatches and skip fusion:

- ``fts``     — ``websearch_to_tsquery`` + ``ts_rank_cd``; with an embedding
                endpoint the query is embedded and blended via cosine similarity
                on ``halfvec``. ``websearch_to_tsquery`` honors ``OR``, phrase
                quoting, and ``-NOT`` (PR #192).
- ``trigram`` — ``pg_trgm`` similarity (fuzzy / typo-tolerant / literal tokens)
- ``regex``   — PostgreSQL ``~*``
- ``vector``  — pure ANN over the HNSW index (requires an embedding)

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
from typing import List, Literal, Optional, Tuple

from .client import RivetMemoryClient
from .scoring import (
    SUMMARY_IMPORTANCE,
    W_FTS,
    W_IMPORTANCE,
    W_SEMANTIC,
    W_TEMPORAL,
    importance_sql,
    reciprocal_rank_fusion,
    temporal_decay_sql,
)

logger = logging.getLogger(__name__)

EMBED_TIMEOUT_S = 5.0

# pgvector halfvec column is 4000 dims; nemotron returns 4096 natively. Embedding
# worker truncates stored rows the same way, so query-side must match.
EMBED_DIMS = 4000

# Candidate pool depth retrieved per method before RRF fusion. Deeper pools let
# a doc one method ranks mediocre — but another ranks highly — still surface.
HYBRID_POOL_MIN = 50
HYBRID_POOL_MAX = 100

SearchMode = Literal["hybrid", "fts", "trigram", "regex", "vector"]
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
        mode: SearchMode = "hybrid",
        scope: SearchScope = "both",
        limit: int = 20,
        agent: Optional[str] = None,
        since: Optional[str] = None,
        before: Optional[str] = None,
    ) -> List[SearchHit]:
        if mode == "hybrid":
            top = self._hybrid_search(query, scope, limit, agent, since, before)
        elif mode == "vector":
            qvec = self._embed_query(query)
            if qvec is None:
                # No embedding available — degrade to FTS rather than nothing.
                return self._single_text_search(
                    "fts", query, scope, limit, agent, since, before
                )
            top = self.vector_search(qvec, scope=scope, limit=limit, agent=agent)
            return top  # vector_search already bumps access
        else:
            return self._single_text_search(
                mode, query, scope, limit, agent, since, before
            )

        self._bump_access_async(top)
        return top

    def _single_text_search(
        self,
        mode: SearchMode,
        query: str,
        scope: SearchScope,
        limit: int,
        agent: Optional[str],
        since: Optional[str],
        before: Optional[str],
    ) -> List[SearchHit]:
        """Single-method text search (fts / trigram / regex) with the original
        composite scoring. The explicit escape hatch."""
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
        self._bump_access_async(top)
        return top

    # -- Hybrid retrieval (default) -----------------------------------------

    def _hybrid_search(
        self,
        query: str,
        scope: SearchScope,
        limit: int,
        agent: Optional[str],
        since: Optional[str],
        before: Optional[str],
    ) -> List[SearchHit]:
        """Run FTS, trigram, and vector arms over a deep candidate pool, fuse
        with RRF, scale by recency/importance, return top N. The vector arm is
        dropped gracefully when no query embedding can be produced."""
        pool = min(HYBRID_POOL_MAX, max(HYBRID_POOL_MIN, limit * 3))
        qvec = self._embed_query(query) if self._embed_endpoint else None

        lists: List[List[Tuple[SearchHit, float]]] = [
            self._retrieve_text_candidates("fts", query, scope, pool, agent, since, before),
            self._retrieve_text_candidates(
                "trigram", query, scope, pool, agent, since, before
            ),
        ]
        if qvec is not None:
            lists.append(
                self._retrieve_vector_candidates(qvec, scope, pool, agent, since, before)
            )

        return self._rrf_fuse(lists)[:limit]

    @staticmethod
    def _rrf_fuse(lists: List[List[Tuple[SearchHit, float]]]) -> List[SearchHit]:
        """Fuse ranked (hit, boost) lists with RRF, then scale each fused score
        by ``1 + boost`` so recency/importance nudges adjacent ranks without
        overriding a strong cross-method match. Dedupes by type+id."""
        # Each list is ordered best-first; RRF needs just the hits in order.
        hit_lists = [[hit for hit, _ in lst] for lst in lists]
        boost_by_key = {
            f"{hit.type}:{hit.id}": boost for lst in lists for hit, boost in lst
        }
        fused = reciprocal_rank_fusion(hit_lists, lambda h: f"{h.type}:{h.id}")
        out: List[SearchHit] = []
        for key, (hit, rrf) in fused.items():
            hit.score = rrf * (1.0 + boost_by_key.get(key, 0.0))
            out.append(hit)
        out.sort(key=lambda h: h.score, reverse=True)
        return out

    def _bump_access_async(self, hits: List[SearchHit]) -> None:
        threading.Thread(
            target=self._bump_access,
            args=(hits,),
            name="rivet-memory-bump-access",
            daemon=True,
        ).start()

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

    # -- Internal: hybrid candidate retrievers ------------------------------

    def _retrieve_text_candidates(
        self,
        method: Literal["fts", "trigram"],
        query: str,
        scope: SearchScope,
        pool: int,
        agent: Optional[str],
        since: Optional[str],
        before: Optional[str],
    ) -> List[Tuple[SearchHit, float]]:
        """Retrieve a candidate pool for one text method, ordered by that
        method's raw relevance. Carries the recency/importance boost so fusion
        can apply it once, post-merge."""
        out: List[Tuple[SearchHit, float]] = []

        def score_and_match(alias: str) -> Tuple[str, str]:
            if method == "fts":
                return (
                    f"ts_rank_cd({alias}.content_tsv, "
                    f"websearch_to_tsquery('english', %s))",
                    f"{alias}.content_tsv @@ websearch_to_tsquery('english', %s)",
                )
            return (
                f"similarity({alias}.content, %s)",
                f"similarity({alias}.content, %s) > 0.3",
            )

        if scope in ("messages", "both"):
            score_expr, match = score_and_match("m")
            boost = f"(({temporal_decay_sql('m')}) * {W_TEMPORAL} + ({importance_sql('m')}) * {W_IMPORTANCE})"
            conditions = [match]
            params: list = [query, query]  # SELECT score_expr, then WHERE match
            if agent:
                conditions.append("m.agent = %s")
                params.append(agent)
            if since:
                conditions.append("m.created_at >= %s")
                params.append(since)
            if before:
                conditions.append("m.created_at < %s")
                params.append(before)
            params.append(pool)
            sql = f"""
                SELECT m.id, m.content, m.role, m.agent, m.conversation_id, m.created_at,
                       ({score_expr}) AS method_score,
                       {boost} AS boost
                  FROM ros_messages m
                 WHERE {" AND ".join(conditions)}
                 ORDER BY method_score DESC
                 LIMIT %s
            """
            with self._client.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    rows = cur.fetchall()
            for r in rows:
                out.append(
                    (
                        SearchHit(
                            id=str(r[0]),
                            type="message",
                            content=r[1] or "",
                            role=r[2],
                            agent=r[3],
                            conversation_id=str(r[4]),
                            score=0.0,
                            created_at=r[5],
                        ),
                        float(r[7]),
                    )
                )

        if scope in ("summaries", "both"):
            score_expr, match = score_and_match("s")
            boost = f"(({temporal_decay_sql('s')}) * {W_TEMPORAL} + {SUMMARY_IMPORTANCE} * {W_IMPORTANCE})"
            conditions = [match]
            params = [query, query]
            if since:
                conditions.append("s.created_at >= %s")
                params.append(since)
            if before:
                conditions.append("s.created_at < %s")
                params.append(before)
            params.append(pool)
            sql = f"""
                SELECT s.id, s.content, s.kind, 'summary' AS agent,
                       s.conversation_id, s.created_at,
                       s.kind, s.earliest_at, s.latest_at,
                       ({score_expr}) AS method_score,
                       {boost} AS boost
                  FROM ros_summaries s
                 WHERE {" AND ".join(conditions)}
                 ORDER BY method_score DESC
                 LIMIT %s
            """
            with self._client.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    rows = cur.fetchall()
            for r in rows:
                out.append(
                    (
                        SearchHit(
                            id=str(r[0]),
                            type="summary",
                            content=r[1] or "",
                            role=r[2],
                            agent=r[3],
                            conversation_id=str(r[4]) if r[4] is not None else "",
                            score=0.0,
                            created_at=r[5],
                            kind=r[6],
                            earliest_at=r[7],
                            latest_at=r[8],
                        ),
                        float(r[10]),
                    )
                )

        return out

    def _retrieve_vector_candidates(
        self,
        embedding: List[float],
        scope: SearchScope,
        pool: int,
        agent: Optional[str],
        since: Optional[str],
        before: Optional[str],
    ) -> List[Tuple[SearchHit, float]]:
        """Retrieve a candidate pool via ANN over the HNSW index, ordered by
        cosine distance. Honors agent (messages) + date filters."""
        if len(embedding) > EMBED_DIMS:
            embedding = embedding[:EMBED_DIMS]
        vec = _vec_literal(embedding)
        out: List[Tuple[SearchHit, float]] = []

        if scope in ("messages", "both"):
            boost = f"(({temporal_decay_sql('m')}) * {W_TEMPORAL} + ({importance_sql('m')}) * {W_IMPORTANCE})"
            conditions = ["m.embedding IS NOT NULL"]
            params: list = []
            if agent:
                conditions.append("m.agent = %s")
                params.append(agent)
            if since:
                conditions.append("m.created_at >= %s")
                params.append(since)
            if before:
                conditions.append("m.created_at < %s")
                params.append(before)
            params.append(pool)
            sql = f"""
                SELECT m.id, m.content, m.role, m.agent, m.conversation_id, m.created_at,
                       {boost} AS boost
                  FROM ros_messages m
                 WHERE {" AND ".join(conditions)}
                 ORDER BY m.embedding <=> '{vec}'::halfvec
                 LIMIT %s
            """
            with self._client.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    rows = cur.fetchall()
            for r in rows:
                out.append(
                    (
                        SearchHit(
                            id=str(r[0]),
                            type="message",
                            content=r[1] or "",
                            role=r[2],
                            agent=r[3],
                            conversation_id=str(r[4]),
                            score=0.0,
                            created_at=r[5],
                        ),
                        float(r[6]),
                    )
                )

        if scope in ("summaries", "both"):
            boost = f"(({temporal_decay_sql('s')}) * {W_TEMPORAL} + {SUMMARY_IMPORTANCE} * {W_IMPORTANCE})"
            conditions = ["s.embedding IS NOT NULL"]  # summaries are cross-agent
            params = []
            if since:
                conditions.append("s.created_at >= %s")
                params.append(since)
            if before:
                conditions.append("s.created_at < %s")
                params.append(before)
            params.append(pool)
            sql = f"""
                SELECT s.id, s.content, s.kind, 'summary' AS agent,
                       s.conversation_id, s.created_at,
                       s.kind, s.earliest_at, s.latest_at,
                       {boost} AS boost
                  FROM ros_summaries s
                 WHERE {" AND ".join(conditions)}
                 ORDER BY s.embedding <=> '{vec}'::halfvec
                 LIMIT %s
            """
            with self._client.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    rows = cur.fetchall()
            for r in rows:
                out.append(
                    (
                        SearchHit(
                            id=str(r[0]),
                            type="summary",
                            content=r[1] or "",
                            role=r[2],
                            agent=r[3],
                            conversation_id=str(r[4]) if r[4] is not None else "",
                            score=0.0,
                            created_at=r[5],
                            kind=r[6],
                            earliest_at=r[7],
                            latest_at=r[8],
                        ),
                        float(r[10]),
                    )
                )

        return out

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
