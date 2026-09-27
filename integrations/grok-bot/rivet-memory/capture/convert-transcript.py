#!/usr/bin/env python3
"""Convert a Grok Bot transcript through the capture-core normalizer.

Keeps the historic `SRC DST` interface so run-once.sh / watch.mjs keep working.
Optional `--agent-id UUID` stamps per-bot metadata. Never prints secrets.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist" / "cli.js"
SRC_CLI = HERE / "src" / "cli.ts"


def node_bin() -> str:
    env = os.environ.get("NODE")
    if env:
        return env
    found = shutil.which("node")
    if found:
        return found
    raise FileNotFoundError("convert-transcript: node not found on PATH (set NODE)")


def convert_cmd(
    src: str,
    dst: str,
    agent_id: str | None,
    session: str | None = None,
    session_suffix: str | None = None,
) -> list[str]:
    node = node_bin()
    extra: list[str] = []
    if agent_id:
        extra.extend(["--agent-id", agent_id])
    if session:
        extra.extend(["--session", session])
    if session_suffix is not None:
        extra.extend(["--session-suffix", session_suffix])
    if DIST.is_file():
        return [node, str(DIST), "convert", src, dst, *extra]
    return [node, "--import", "tsx", str(SRC_CLI), "convert", src, dst, *extra]


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--"]
    agent_id = os.environ.get("GROKBOT_AGENT_ID")
    session = os.environ.get("GROKBOT_SESSION")
    session_suffix = os.environ.get("GROKBOT_SESSION_SUFFIX")
    rest: list[str] = []
    i = 0
    while i < len(args):
        if args[i] in ("--agent-id", "--agent_id") and i + 1 < len(args):
            agent_id = args[i + 1]
            i += 2
            continue
        if args[i] == "--session" and i + 1 < len(args):
            session = args[i + 1]
            i += 2
            continue
        if args[i] in ("--session-suffix", "--session_suffix") and i + 1 < len(args):
            session_suffix = args[i + 1]
            i += 2
            continue
        rest.append(args[i])
        i += 1
    if len(rest) != 2:
        print(
            f"Usage: {sys.argv[0]} SRC.jsonl DST.jsonl [--agent-id UUID] [--session KEY] [--session-suffix -v3]",
            file=sys.stderr,
        )
        return 2
    src, dst = rest
    env = os.environ.copy()
    env.setdefault("RIVETOS_ROOT", "/opt/rivetos")
    try:
        proc = subprocess.run(
            convert_cmd(src, dst, agent_id, session, session_suffix), env=env, check=False
        )
    except FileNotFoundError as exc:
        print(f"convert-transcript: cannot run normalizer: {exc}", file=sys.stderr)
        return 1
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
