#!/usr/bin/env python3
"""ReadTranscript -> RivetOS memory bridge (Grok Bot capture after on-disk writes stopped).

An agent that can call ReadTranscript saves each page verbatim (header + JSON
lines + optional footer) and hands it here. Positions are 0-based indices of
the agent's current conversation.

Commands:
  add <agentId> FILE|-      store one page by position
  next <agentId>            LATEST or NEED_OLDER before=N
  ingest [agentId...] [--dry-run] [--suffix -v3]
  ingest-pages --input DIR [--commit] [--overlap-hours 48]
                            ReadTranscript dump backfill (dry-run default)
  status

Ingest runs the capture-core normalizer (16_000 UTF-16 capForStorage, no 4 KB
chop, reads tool_result.result). Session tags are <existing>-v3 by default.
Never prints secrets.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = Path(os.environ.get("HOME") or Path.home())
CAP = Path(os.environ.get("GROKBOT_CAPTURE_DIR") or HERE)
PULL = Path(os.environ.get("GROKBOT_PULL_DIR") or (CAP / "pull"))
STATE = Path(os.environ.get("GROKBOT_PULL_STATE") or (CAP / "pull-state.json"))
SPOOL = CAP / "spool"
NODE = os.environ.get("NODE") or shutil.which("node") or "node"
SUFFIX = os.environ.get("PULL_SESSION_SUFFIX", "-v3")
CLI_JS = HERE / "dist" / "cli.js"
DISCOVER = HERE / "discover-models.mjs"
INGEST = HERE / "ingest.mjs"
BUILD_FIRST = (
    "Build the capture package first "
    "(npx nx build @rivetos/grok-bot-rivet-memory-capture)."
)


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(s: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(STATE.suffix + ".tmp")
    tmp.write_text(json.dumps(s, indent=1), encoding="utf-8")
    tmp.replace(STATE)


def now() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def h(line: str) -> str:
    return hashlib.sha1(line.encode("utf8")).hexdigest()


def require_dist() -> Path:
    if CLI_JS.is_file():
        return CLI_JS
    print(BUILD_FIRST, file=sys.stderr)
    raise SystemExit(2)


def parse_cmd() -> list[str]:
    return [NODE, str(require_dist()), "parse-page", "-"]


def parse_page(text: str):
    """Parse a ReadTranscript page via the TypeScript parser (one implementation)."""
    r = subprocess.run(parse_cmd(), input=text, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit((r.stderr or r.stdout or "parse-page failed")[-400:])
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        raise SystemExit(f"ERROR: parse-page returned non-JSON: {e}") from e
    hdr = data.get("header") or {}
    if not hdr:
        raise SystemExit('ERROR: no "Transcript of ... positions A–B of T:" header found')
    recs = []
    for rec in data.get("records") or []:
        recs.append(rec if isinstance(rec, str) else json.dumps(rec, ensure_ascii=False))
    a, b, total = int(hdr["a"]), int(hdr["b"]), int(hdr["total"])
    if b - a + 1 != len(recs):
        raise SystemExit(
            f"ERROR: header says {b - a + 1} records ({a}–{b}) but page has {len(recs)} JSON lines"
        )
    return hdr, a, b, total, recs, None


def load_pull(aid: str) -> dict:
    p = PULL / f"{aid}.jsonl"
    d = {}
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if line.strip():
                o = json.loads(line)
                d[o["pos"]] = o
    return d


def coverage(held: dict, total: int):
    top = (total - 1) if total else (max(held) if held else -1)
    contig = -1
    while contig + 1 in held:
        contig += 1
    missing_top = next((p for p in range(top, -1, -1) if p not in held), None)
    return contig, top, missing_top


def cmd_add(aid: str, path: str, force: bool = False) -> None:
    text = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    hdr, a, b, total, recs, _before = parse_page(text)
    if hdr.get("id") and hdr["id"] != aid:
        raise SystemExit(f"ERROR: page is for agent {hdr['id']}, not {aid}")
    held = load_pull(aid)
    st = load_state()
    s = st.setdefault(aid, {})
    conflicts = [
        a + i for i, line in enumerate(recs) if (a + i) in held and held[a + i]["h"] != h(line)
    ]
    if conflicts and not force:
        print(
            f"CONFLICT positions {conflicts[:5]}{'...' if len(conflicts) > 5 else ''} differ from stored content "
            f"(conversation reset/rewritten?). Nothing written. Investigate, then rotate PULL_SESSION_SUFFIX or re-run with --force."
        )
        sys.exit(3)
    new = 0
    for i, line in enumerate(recs):
        p = a + i
        if p in held and held[p]["h"] == h(line):
            continue
        held[p] = {"pos": p, "h": h(line), "rec": json.loads(line)}
        new += 1
    PULL.mkdir(parents=True, exist_ok=True)
    tmp = PULL / f"{aid}.jsonl.tmp"
    with tmp.open("w", encoding="utf-8") as o:
        for p in sorted(held):
            o.write(json.dumps(held[p], ensure_ascii=False) + "\n")
    tmp.replace(PULL / f"{aid}.jsonl")
    s["total"] = max(s.get("total", 0), total)
    if hdr.get("name"):
        s["name"] = hdr["name"]
    contig, _top, miss = coverage(held, s["total"])
    s.update(held_count=len(held), contiguous_to=contig, max_pos=max(held) if held else -1, last_pull_at=now())
    save_state(st)
    tag = f"+{new} new (page {a}–{b} of {total}; held {len(held)}, contiguous 0–{contig})"
    if a > 0 and (a - 1) not in held:
        print(f"NEED_OLDER before={a} {tag}")
    elif miss is not None:
        print(f"NEED_OLDER before={miss + 1} {tag}")
    else:
        print(f"DONE {tag}")


def cmd_next(aid: str) -> None:
    st = load_state()
    s = st.get(aid, {})
    held = load_pull(aid)
    if not held:
        print("LATEST")
        return
    _contig, _top, miss = coverage(held, s.get("total", 0))
    if miss is not None and miss < max(held):
        print(f"NEED_OLDER before={miss + 1}")
    else:
        print("LATEST")


def identities():
    out = subprocess.run(
        [NODE, str(DISCOVER), "--json"], capture_output=True, text=True, check=True
    ).stdout
    cat = json.loads(out)
    return {m["id"]: m for m in cat["models"]}, cat.get("nodeId", "grokbot")


def convert_cmd(src: Path, dst: Path, agent_id: str, session: str | None = None) -> list[str]:
    extra = [f"--agent-id={agent_id}"]
    if session:
        extra.append(f"--session={session}")
    return [NODE, str(require_dist()), "convert", str(src), str(dst), *extra]


def cmd_ingest(ids: list[str], dry: bool, suffix: str) -> int:
    require_dist()
    st = load_state()
    models, node_id = identities()
    rc = 0
    ids = ids or [p.stem for p in sorted(PULL.glob("*.jsonl"))]
    SPOOL.mkdir(parents=True, exist_ok=True)
    for aid in ids:
        held = load_pull(aid)
        if not held:
            print(f"SKIP {aid}: nothing pulled")
            continue
        m = models.get(aid) or {
            "session": f"{node_id}-run-{aid}",
            "agent": "grokbot-run",
            "persona": "run",
        }
        session = m["session"] + suffix
        max_pos = max(held)
        page_lines = [
            f'Transcript of agent "{m.get("persona", "agent")}" ({aid}), positions 0–{max_pos} of {max_pos + 1}:'
        ]
        for p in range(max_pos + 1):
            if p in held:
                page_lines.append(json.dumps(held[p]["rec"], ensure_ascii=False))
            else:
                page_lines.append('{"role":"user","message":{"content":[{"type":"text","text":""}]}}')
        tmp_page = SPOOL / f"pull-{session}.page.txt"
        tmp_page.write_text("\n".join(page_lines) + "\n", encoding="utf-8")
        spool = SPOOL / f"pull-{session}.jsonl"
        info = (
            f'{m["persona"]} session={session} agent={m["agent"]} '
            f"positions=0–{max_pos} held={len(held)}"
        )
        conv = subprocess.run(
            convert_cmd(tmp_page, spool, aid, session), capture_output=True, text=True
        )
        if conv.returncode != 0:
            rc = 1
            print(f"FAIL convert {info}: {(conv.stderr or conv.stdout)[-300:]}")
            continue
        if dry:
            print(f"DRY {info} spool={spool} {conv.stdout.strip()}")
            continue
        r = subprocess.run(
            [
                NODE,
                str(INGEST),
                "ingest",
                "--session-id",
                session,
                "--agent",
                m["agent"],
                "--persona",
                m["persona"],
                str(spool),
            ],
            capture_output=True,
            text=True,
            env={**os.environ, "RIVETOS_ROOT": os.environ.get("RIVETOS_ROOT", "/opt/rivetos")},
        )
        if r.returncode == 0:
            res = json.loads(r.stdout.strip().splitlines()[-1])
            st.setdefault(aid, {})["last_ingest"] = {
                "at": now(),
                "ingested": res.get("ingested"),
                "max_pos": max_pos,
            }
            st[aid]["ingested_to"] = max_pos
            save_state(st)
            print(f'OK {info} ingested={res.get("ingested")} skipped={res.get("skipped")}')
        else:
            rc = 1
            print(f"FAIL {info} exit={r.returncode}: {(r.stderr or r.stdout)[-300:]}")
    return rc


def cmd_ingest_pages(argv: list[str]) -> int:
    """Delegate page-dump backfill to the TypeScript normalizer (dry-run default)."""
    require_dist()
    r = subprocess.run([NODE, str(CLI_JS), "ingest-pages", *argv])
    return int(r.returncode or 0)


def cmd_status() -> None:
    st = load_state()
    for aid, s in sorted(st.items(), key=lambda kv: kv[1].get("name", kv[0])):
        print(
            f'{str(s.get("name", "?"))[:12]:12} {aid} total={s.get("total")} held={s.get("held_count")} '
            f'contiguous=0–{s.get("contiguous_to")} ingested_to={s.get("ingested_to")} last_ingest={s.get("last_ingest")}'
        )


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help", "help"):
        print(__doc__)
        sys.exit(0)
    if a[0] == "add" and len(a) >= 3:
        cmd_add(a[1], a[2], "--force" in a)
    elif a[0] == "next" and len(a) >= 2:
        cmd_next(a[1])
    elif a[0] == "ingest":
        suffix = SUFFIX
        rest = []
        i = 1
        while i < len(a):
            if a[i] == "--suffix" and i + 1 < len(a):
                suffix = a[i + 1]
                i += 2
                continue
            if not a[i].startswith("--"):
                rest.append(a[i])
            i += 1
        sys.exit(cmd_ingest(rest, "--dry-run" in a, suffix))
    elif a[0] == "ingest-pages":
        sys.exit(cmd_ingest_pages(a[1:]))
    elif a[0] == "status":
        cmd_status()
    else:
        print(__doc__)
        sys.exit(2)
