"""Unit tests for reciprocal_rank_fusion — pure, no DB.

Imports are deferred into each test because the ``rivet_memory`` package alias
is installed by a session-scoped autouse fixture (see ``conftest.py``), which
runs after module collection — so a top-level import would fail.
"""

from __future__ import annotations


def _key(x):
    return x["id"]


def test_single_list_scores_by_inverse_rank():
    from rivet_memory.scoring import reciprocal_rank_fusion

    a, b = {"id": "a"}, {"id": "b"}
    fused = reciprocal_rank_fusion([[a, b]], _key, 60)
    assert abs(fused["a"][1] - 1 / 61) < 1e-12
    assert abs(fused["b"][1] - 1 / 62) < 1e-12


def test_accumulates_across_lists():
    from rivet_memory.scoring import reciprocal_rank_fusion

    a = {"id": "a"}
    # 'a' is rank 1 in list one and rank 2 in list two.
    fused = reciprocal_rank_fusion([[a], [{"id": "x"}, a]], _key, 60)
    assert abs(fused["a"][1] - (1 / 61 + 1 / 62)) < 1e-12


def test_two_method_hit_beats_single_method_hit():
    from rivet_memory.scoring import reciprocal_rank_fusion

    shared = {"id": "shared"}
    lonely = {"id": "lonely"}
    # 'shared' is rank 3 in list one but also rank 2 in list two; 'lonely' is
    # only rank 1 in list two. Fusion should lift the cross-method hit above.
    fused = reciprocal_rank_fusion(
        [[{"id": "p"}, {"id": "q"}, shared], [lonely, shared]], _key, 60
    )
    assert fused["shared"][1] > fused["lonely"][1]


def test_keeps_first_seen_item_on_collision():
    from rivet_memory.scoring import reciprocal_rank_fusion

    first = {"id": "a", "tag": "first"}
    second = {"id": "a", "tag": "second"}
    fused = reciprocal_rank_fusion([[first], [second]], _key, 60)
    assert fused["a"][0]["tag"] == "first"


def test_smaller_k_sharpens_top_rank_advantage():
    from rivet_memory.scoring import reciprocal_rank_fusion

    a, b = {"id": "a"}, {"id": "b"}
    sharp = reciprocal_rank_fusion([[a, b]], _key, 1)
    flat = reciprocal_rank_fusion([[a, b]], _key, 1000)
    assert (sharp["a"][1] - sharp["b"][1]) > (flat["a"][1] - flat["b"][1])


def test_default_k_is_60():
    from rivet_memory.scoring import RRF_K_DEFAULT, reciprocal_rank_fusion

    assert RRF_K_DEFAULT == 60
    fused = reciprocal_rank_fusion([[{"id": "a"}]], _key)
    assert abs(fused["a"][1] - 1 / 61) < 1e-12


def test_empty_and_missing_lists():
    from rivet_memory.scoring import reciprocal_rank_fusion

    assert reciprocal_rank_fusion([], _key) == {}
    assert reciprocal_rank_fusion([[], []], _key) == {}
