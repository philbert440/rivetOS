"""Relevance scoring — pure math, no I/O.

Direct Python port of ``plugins/memory/postgres/src/scoring.ts``. Weights and
formulas must stay in sync with the TS engine so the Hermes plugin ranks hits
the same way every other RivetOS consumer does.

Formula (MEMORY-DESIGN.md)::

    relevance = (fts_rank × 0.3)
              + (semantic × 0.3)
              + (temporal × 0.3)
              + (importance × 0.1)

Temporal uses Ebbinghaus-style decay with access reinforcement::

    temporal = e^(-λ × days_since_access) × (1 + α × access_count)
"""

from __future__ import annotations

import math
from typing import Callable, Dict, List, Sequence, Tuple, TypeVar

_T = TypeVar("_T")

# Decay rate — how fast memories fade without reinforcement.
DECAY_LAMBDA = 0.05

# Reinforcement — how much each access slows decay.
REINFORCEMENT_ALPHA = 0.02

# Composite weights (must sum to 1.0).
W_FTS = 0.3
W_SEMANTIC = 0.3
W_TEMPORAL = 0.3
W_IMPORTANCE = 0.1

# Summaries get a fixed mid-range importance — they're already distilled.
SUMMARY_IMPORTANCE = 0.6

# Canonical Reciprocal Rank Fusion smoothing constant (Cormack et al., 2009).
RRF_K_DEFAULT = 60


def temporal_decay(days_since_access: float, access_count: int) -> float:
    """In-Python temporal score. Same formula as ``temporalDecaySql`` below."""
    return math.exp(-DECAY_LAMBDA * days_since_access) * (
        1.0 + REINFORCEMENT_ALPHA * access_count
    )


def importance_for_role(role: str, has_tool_call: bool) -> float:
    """Base importance score by message kind."""
    if role == "system":
        return 0.9
    if has_tool_call:
        return 0.7
    if role == "user":
        return 0.6
    return 0.5  # assistant without tools


def compute_relevance(
    fts_rank: float,
    semantic_sim: float,
    temporal_score: float,
    importance: float,
) -> float:
    return (
        fts_rank * W_FTS
        + semantic_sim * W_SEMANTIC
        + temporal_score * W_TEMPORAL
        + importance * W_IMPORTANCE
    )


# ---------------------------------------------------------------------------
# Reciprocal Rank Fusion
# ---------------------------------------------------------------------------


def reciprocal_rank_fusion(
    lists: Sequence[Sequence[_T]],
    key_of: Callable[[_T], str],
    k: int = RRF_K_DEFAULT,
) -> Dict[str, Tuple[_T, float]]:
    """Fuse several ranked lists with Reciprocal Rank Fusion.

    Each list is assumed ordered best-first. A document's fused score is the sum
    over the lists it appears in of ``1 / (k + rank)`` (rank is 1-based). A
    larger ``k`` flattens the advantage of top ranks. Documents are identified
    across lists by ``key_of`` and accumulate contributions from every list.

    Pure and rank-based — no score normalization needed, which is the point of
    RRF: it fuses heterogeneous scorers (ts_rank_cd, trigram similarity, cosine
    distance) that aren't otherwise comparable. Returns an insertion-ordered
    mapping of key -> (first-seen item, fused score).
    """
    acc: Dict[str, Tuple[_T, float]] = {}
    for lst in lists:
        for idx, item in enumerate(lst):
            key = key_of(item)
            inc = 1.0 / (k + idx + 1)  # rank is idx + 1 (1-based)
            if key in acc:
                acc[key] = (acc[key][0], acc[key][1] + inc)
            else:
                acc[key] = (item, inc)
    return acc


# ---------------------------------------------------------------------------
# SQL fragments — inlined into search.py / recall.py queries
# ---------------------------------------------------------------------------


def temporal_decay_sql(alias: str) -> str:
    """SQL expression for temporal decay over ``<alias>.created_at`` /
    ``last_accessed_at`` / ``access_count``."""
    return (
        f"EXP(-{DECAY_LAMBDA} * EXTRACT(EPOCH FROM "
        f"(NOW() - COALESCE({alias}.last_accessed_at, {alias}.created_at))) / 86400.0) "
        f"* (1.0 + {REINFORCEMENT_ALPHA} * COALESCE({alias}.access_count, 0))"
    )


def importance_sql(alias: str) -> str:
    """SQL CASE expression for message importance over ``<alias>.role`` and
    ``<alias>.tool_name``."""
    return (
        f"CASE WHEN {alias}.role = 'system' THEN 0.9 "
        f"WHEN {alias}.tool_name IS NOT NULL THEN 0.7 "
        f"WHEN {alias}.role = 'user' THEN 0.6 "
        f"ELSE 0.5 END"
    )
