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
