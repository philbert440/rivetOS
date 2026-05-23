"""End-to-end round trip against a live RivetOS datahub Postgres.

Skipped unless ``RIVETOS_PG_URL`` is set. CI should run this with a
disposable test database. Writes are tagged ``agent='rivet-hermes-test'``
so they're trivial to clean up if needed.
"""

from __future__ import annotations

import os
import uuid

import pytest

if not os.environ.get("RIVETOS_PG_URL"):
    pytest.skip(
        "RIVETOS_PG_URL not set — skipping live round-trip", allow_module_level=True
    )


def test_capture_then_search_finds_the_turn():
    from rivet_memory.capture import Capture
    from rivet_memory.client import RivetMemoryClient
    from rivet_memory.recall import SearchEngine
    from rivet_memory.tools import Tools

    session_id = f"pytest-{uuid.uuid4().hex[:10]}"
    session_key = f"hermes:{session_id}"
    agent = "rivet-hermes-test"
    channel = "hermes-pytest"
    marker = f"round-trip marker {session_id}"

    client = RivetMemoryClient(os.environ["RIVETOS_PG_URL"])
    try:

        def ctx():
            return (session_key, agent, channel)

        cap = Capture(client, ctx)
        try:
            cap.ingest_turn(f"USER: {marker}", f"ASSISTANT: {marker}")
            assert cap.flush(timeout=10.0)
        finally:
            cap.shutdown(timeout=5.0)

        eng = SearchEngine(client, embed_endpoint=os.environ.get("RIVETOS_EMBED_URL"))
        tools = Tools(client, eng)

        # Direct SQL search via engine — bypasses the formatter so we can assert.
        hits = eng.search(marker, mode="fts", scope="messages", limit=10, agent=agent)
        contents = [h.content for h in hits]
        assert any(marker in c for c in contents), f"marker not found in {contents}"
    finally:
        # Cleanup: mark our conversation inactive so it doesn't pollute future runs.
        try:
            client.close_by_session_key(session_key, agent)
        except Exception:
            pass
        client.close()
