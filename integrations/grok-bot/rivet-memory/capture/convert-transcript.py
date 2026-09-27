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
BUILD_FIRST = (
    "Build the capture package first "
    "(npx nx build @rivetos/grok-bot-rivet-memory-capture)."
)


def node_bin() -> str:
    env = os.environ.get("NODE")
    if env:
        return env
    found = shutil.which("node")
    if found:
        return found
    raise FileNotFoundError("convert-transcript: node not found on PATH (set NODE)")


def require_dist() -> Path:
    if DIST.is_file():
        return DIST
    print(BUILD_FIRST, file=sys.stderr)
    raise SystemExit(2)


def take_flag(args: list[str], i: int, names: tuple[str, ...]) -> tuple[str, int] | None:
    """Accept both `--flag value` and `--flag=value`."""
    cur = args[i]
    for name in names:
        if cur == name and i + 1 < len(args):
            return args[i + 1], i + 2
        prefix = f"{name}="
        if cur.startswith(prefix):
            return cur[len(prefix) :], i + 1
    return None


def parse_convert_args(
    args: list[str],
) -> tuple[str | None, str | None, str | None, list[str]]:
    agent_id = os.environ.get("GROKBOT_AGENT_ID")
    session = os.environ.get("GROKBOT_SESSION")
    session_suffix = os.environ.get("GROKBOT_SESSION_SUFFIX")
    rest: list[str] = []
    i = 0
    while i < len(args):
        taken = take_flag(args, i, ("--agent-id", "--agent_id"))
        if taken:
            agent_id, i = taken
            continue
        taken = take_flag(args, i, ("--session",))
        if taken:
            session, i = taken
            continue
        taken = take_flag(args, i, ("--session-suffix", "--session_suffix"))
        if taken:
            session_suffix, i = taken
            continue
        rest.append(args[i])
        i += 1
    return agent_id, session, session_suffix, rest


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
        extra.append(f"--agent-id={agent_id}")
    if session:
        extra.append(f"--session={session}")
    if session_suffix is not None:
        extra.append(f"--session-suffix={session_suffix}")
    return [node, str(require_dist()), "convert", src, dst, *extra]


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--"]
    agent_id, session, session_suffix, rest = parse_convert_args(args)
    if len(rest) != 2:
        print(
            f"Usage: {sys.argv[0]} SRC.jsonl DST.jsonl [--agent-id UUID] [--session KEY] [--session-suffix=-v3]",
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
