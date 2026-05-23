"""CLI subcommands for the rivet-memory Hermes plugin.

Loaded by Hermes when ``memory.provider: rivet_memory`` is active (see
``plugins/memory/__init__.py:discover_plugin_cli_commands``). Exposes
``hermes rivet_memory {status,test,search,browse,stats}``.

Setup is intentionally not duplicated here — ``hermes memory setup`` already
walks the provider's ``get_config_schema()`` and writes secrets/config.
"""

from __future__ import annotations

import os
import sys
import uuid
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Helpers — load runtime config + build a client lazily
# ---------------------------------------------------------------------------


def _pg_url() -> Optional[str]:
    if os.environ.get("RIVETOS_PG_URL"):
        return os.environ["RIVETOS_PG_URL"]
    try:
        from hermes_cli.config import load_config, cfg_get

        cfg = load_config()
        v = cfg_get(cfg, "memory", "rivet_memory", "pg_url")
        return v or None
    except Exception:
        return None


def _embed_url() -> Optional[str]:
    if os.environ.get("RIVETOS_EMBED_URL"):
        return os.environ["RIVETOS_EMBED_URL"]
    try:
        from hermes_cli.config import load_config, cfg_get

        cfg = load_config()
        v = cfg_get(cfg, "memory", "rivet_memory", "embed_endpoint")
        return v or None
    except Exception:
        return None


def _make_tools():
    """Build (client, tools) for CLI commands. Exits cleanly on misconfig."""
    pg = _pg_url()
    if not pg:
        print("  rivet_memory: RIVETOS_PG_URL is not set.")
        print("  Run `hermes memory setup` to configure, or export the env var.")
        sys.exit(2)
    from .client import RivetMemoryClient
    from .recall import SearchEngine
    from .tools import Tools

    client = RivetMemoryClient(pg)
    engine = SearchEngine(client, embed_endpoint=_embed_url())
    return client, Tools(client, engine)


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------


def cmd_status(_args: Any) -> None:
    pg = _pg_url()
    embed = _embed_url()
    print("## rivet_memory status\n")
    print(f"  PG URL configured:    {'yes' if pg else 'NO'}")
    if pg:
        # Mask credentials before printing.
        try:
            from urllib.parse import urlsplit, urlunsplit

            u = urlsplit(pg)
            netloc = u.hostname or ""
            if u.port:
                netloc = f"{netloc}:{u.port}"
            if u.username:
                netloc = f"{u.username}:***@{netloc}"
            print(f"  PG target:            {urlunsplit((u.scheme, netloc, u.path, '', ''))}")
        except Exception:
            print("  PG target:            (unparseable URL)")
    print(f"  Embed URL configured: {'yes' if embed else 'no (length-proxy fallback)'}")
    if not pg:
        return

    # Live ping.
    from .client import RivetMemoryClient

    client = RivetMemoryClient(pg)
    ok = client.ping()
    client.close()
    print(f"  Datahub reachable:    {'yes' if ok else 'NO'}")


def cmd_test(_args: Any) -> None:
    """Round-trip: write a turn, read it back, then close the conversation."""
    client, tools = _make_tools()
    try:
        from .capture import Capture

        session_id = f"cli-test-{uuid.uuid4().hex[:8]}"
        session_key = f"hermes:{session_id}"
        agent = "rivet-hermes"
        channel = "hermes-cli"

        def ctx():
            return (session_key, agent, channel)

        capture = Capture(client, ctx)
        marker = f"hermes rivet_memory test {session_id}"
        capture.ingest_turn(f"USER: {marker}", f"ASSISTANT: {marker}")
        capture.flush(timeout=10.0)
        capture.shutdown(timeout=5.0)

        hits = tools.dispatch(
            "rivet_memory_search", {"query": marker, "agent": agent, "limit": 5}
        )
        print(hits)
        # Best-effort cleanup so the test doesn't leave a dangling active conv.
        client.close_by_session_key(session_key, agent)
        print(f"\n  cleaned up conversation for session_key={session_key}")
    finally:
        client.close()


def cmd_search(args: Any) -> None:
    query = " ".join(getattr(args, "query", []) or []).strip()
    if not query:
        print("  Usage: hermes rivet_memory search <query>")
        sys.exit(2)
    client, tools = _make_tools()
    try:
        print(
            tools.dispatch(
                "rivet_memory_search",
                {
                    "query": query,
                    "agent": getattr(args, "agent", None),
                    "limit": getattr(args, "limit", None) or 10,
                    "mode": getattr(args, "mode", None) or "fts",
                    "scope": getattr(args, "scope", None) or "both",
                },
            )
        )
    finally:
        client.close()


def cmd_browse(args: Any) -> None:
    client, tools = _make_tools()
    try:
        print(
            tools.dispatch(
                "rivet_memory_browse",
                {
                    "agent": getattr(args, "agent", None),
                    "limit": getattr(args, "limit", None) or 25,
                    "order": getattr(args, "order", None) or "desc",
                    "conversation_id": getattr(args, "conversation", None),
                },
            )
        )
    finally:
        client.close()


def cmd_stats(args: Any) -> None:
    client, tools = _make_tools()
    try:
        print(
            tools.dispatch(
                "rivet_memory_stats",
                {"agent": getattr(args, "agent", None)},
            )
        )
    finally:
        client.close()


# ---------------------------------------------------------------------------
# Dispatcher + register_cli
# ---------------------------------------------------------------------------


def rivet_memory_command(args: Any) -> None:
    """Route ``hermes rivet_memory <sub>`` calls."""
    sub = getattr(args, "rivet_memory_command", None)
    if sub is None or sub == "status":
        cmd_status(args)
    elif sub == "test":
        cmd_test(args)
    elif sub == "search":
        cmd_search(args)
    elif sub == "browse":
        cmd_browse(args)
    elif sub == "stats":
        cmd_stats(args)
    else:
        print(f"  Unknown rivet_memory subcommand: {sub}")
        print("  Available: status, test, search, browse, stats")
        sys.exit(2)


def register_cli(subparser) -> None:
    """Hook into Hermes's argparse tree for ``hermes rivet_memory``."""
    subs = subparser.add_subparsers(dest="rivet_memory_command")

    subs.add_parser("status", help="Show config + ping the datahub Postgres")
    subs.add_parser("test", help="Round-trip a turn through capture + recall")

    search = subs.add_parser("search", help="Search RivetOS shared memory")
    search.add_argument("query", nargs="*", help="Search query (free text)")
    search.add_argument("--agent", help="Filter by agent (rivet-hermes, rivet-claude, opus, ...)")
    search.add_argument("--limit", type=int, default=10, help="Max results (default 10)")
    search.add_argument("--mode", choices=["fts", "trigram", "regex"], default="fts")
    search.add_argument(
        "--scope",
        choices=["messages", "summaries", "both"],
        default="both",
    )

    browse = subs.add_parser("browse", help="Chronological message browse")
    browse.add_argument("--agent", help="Filter by agent")
    browse.add_argument("--limit", type=int, default=25)
    browse.add_argument("--order", choices=["asc", "desc"], default="desc")
    browse.add_argument("--conversation", help="Browse a specific conversation id")

    stats = subs.add_parser("stats", help="Memory system health summary")
    stats.add_argument("--agent", help="Filter stats by agent")

    subparser.set_defaults(func=rivet_memory_command)
