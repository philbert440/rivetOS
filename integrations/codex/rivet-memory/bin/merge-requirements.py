#!/usr/bin/env python3
"""Structurally merge rivet-memory capture hooks into Codex requirements.toml.

Usage:
  merge-requirements.py apply  --plugin-bin DIR [--existing FILE | --stdin] [--out FILE]
  merge-requirements.py remove --plugin-bin DIR [--existing FILE | --stdin] [--out FILE]

Exit codes:
  0  merged (or already in the desired state)
  1  generic error
  2  foreign managed_dir — do not write; caller should use user hooks.json only
  3  existing file is not valid TOML — bytes left untouched
  4  python3 tomllib unavailable — cannot merge, edit by hand
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from typing import Any

MARKER_SCRIPT = "codex-memory-capture.sh"
MARKER_FLAG = "--hook"
HOOK_EVENTS = ("UserPromptSubmit", "Stop", "SessionEnd")
HOOK_TIMEOUT = 20

# ---------------------------------------------------------------------------
# tomllib
# ---------------------------------------------------------------------------

def _load_tomllib():
    try:
        import tomllib  # type: ignore[attr-defined]

        return tomllib
    except ImportError:
        return None


def _fail_no_tomllib(snippet: str) -> None:
    sys.stderr.write(
        "cannot merge: python3 tomllib is unavailable (need Python 3.11+). "
        "Edit /etc/codex/requirements.toml by hand; refusing to write an invalid file.\n"
    )
    if snippet.strip():
        sys.stderr.write("--- existing snippet ---\n")
        sys.stderr.write(snippet[:2000])
        if not snippet.endswith("\n"):
            sys.stderr.write("\n")
        sys.stderr.write("--- end snippet ---\n")
    raise SystemExit(4)


# ---------------------------------------------------------------------------
# quoting / our entries
# ---------------------------------------------------------------------------

def shell_quote(value: str) -> str:
    # bash single-quote with '\'' escaping
    return "'" + value.replace("'", r"'\''") + "'"


def hook_command(plugin_bin: str) -> str:
    script = os.path.join(plugin_bin, MARKER_SCRIPT)
    return f"bash {shell_quote(script)} {MARKER_FLAG}"


def command_is_ours(command: Any) -> bool:
    text = command if isinstance(command, str) else ""
    return MARKER_SCRIPT in text and MARKER_FLAG in text


def our_entry(plugin_bin: str) -> dict[str, Any]:
    """One HookHandlerConfig group: `[[hooks.<Event>]]` + `[[hooks.<Event>.hooks]]`.

    This is the shape Codex 0.154 actually loads (verified on ct113 2026-09-12);
    a flat `command =` directly under `[[hooks.<Event>]]` is ignored.
    """
    return {
        "hooks": [
            {"type": "command", "command": hook_command(plugin_bin), "timeout": HOOK_TIMEOUT}
        ]
    }


def _group_commands(group: Any) -> list[Any]:
    """Commands inside a hook group: the nested `hooks[*].command` list, plus a
    legacy flat `command` for tolerance when reading."""
    if not isinstance(group, dict):
        return []
    out: list[Any] = []
    inner = group.get("hooks")
    if isinstance(inner, list):
        for item in inner:
            if isinstance(item, dict):
                out.append(item.get("command"))
    if "command" in group:
        out.append(group.get("command"))
    return out


def group_is_ours(group: Any) -> bool:
    return any(command_is_ours(c) for c in _group_commands(group))


def group_has_foreign(group: Any) -> bool:
    return any(not command_is_ours(c) for c in _group_commands(group))


def strip_ours(group: dict[str, Any]) -> tuple[dict[str, Any] | None, int]:
    """Remove our inner commands from a group; None when nothing is left."""
    removed = 0
    new_group = dict(group)
    inner = group.get("hooks")
    if isinstance(inner, list):
        kept = []
        for item in inner:
            if isinstance(item, dict) and command_is_ours(item.get("command")):
                removed += 1
            else:
                kept.append(item)
        if kept:
            new_group["hooks"] = kept
        else:
            new_group.pop("hooks", None)
    if command_is_ours(group.get("command")):
        new_group.pop("command", None)
        new_group.pop("timeout", None)
        removed += 1
    has_commands = bool(_group_commands(new_group))
    return (new_group if has_commands else None), removed


def normalize_dir(value: str) -> str:
    return os.path.normpath(os.path.abspath(value))


def managed_dir_is_ours(managed: Any, plugin_bin: str) -> bool:
    if not isinstance(managed, str) or not managed.strip():
        return False
    return normalize_dir(managed) == normalize_dir(plugin_bin)


# ---------------------------------------------------------------------------
# TOML writer (strings / ints / bools / arrays of tables)
# ---------------------------------------------------------------------------

def _toml_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _toml_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return _toml_str(value)
    if isinstance(value, list) and all(not isinstance(x, dict) for x in value):
        return "[" + ", ".join(_toml_scalar(x) for x in value) + "]"
    raise TypeError(f"unsupported TOML value: {type(value).__name__}")


def _is_array_of_tables(value: Any) -> bool:
    return isinstance(value, list) and len(value) > 0 and all(isinstance(x, dict) for x in value)


def _is_table(value: Any) -> bool:
    return isinstance(value, dict)


_BARE_KEY = re.compile(r"[A-Za-z0-9_-]+")


def _key(key: str) -> str:
    """TOML key component: bare when allowed, else a basic (quoted) string so a
    dotted or spaced key like `"audit.prod"` keeps its identity."""
    return key if _BARE_KEY.fullmatch(key) else _toml_str(key)


def _dump_pair(key: str, value: Any) -> str:
    return f"{_key(key)} = {_toml_scalar(value)}"


def _dump_table_header(path: str, array: bool = False) -> str:
    return f"[[{path}]]" if array else f"[{path}]"


def _dump_inline_pairs(table: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    for key, value in table.items():
        if _is_table(value) or _is_array_of_tables(value):
            continue
        lines.append(_dump_pair(key, value))
    return lines


def _dump_nested(prefix: str, table: dict[str, Any]) -> list[str]:
    chunks: list[str] = []
    for key, value in table.items():
        path = f"{prefix}.{_key(key)}" if prefix else _key(key)
        if _is_array_of_tables(value):
            for item in value:
                chunks.append(_dump_table_header(path, array=True))
                chunks.extend(_dump_inline_pairs(item))
                nested = _dump_nested(path, {k: v for k, v in item.items() if _is_table(v) or _is_array_of_tables(v)})
                if nested:
                    chunks.append("")
                    chunks.extend(nested)
                chunks.append("")
        elif _is_table(value):
            chunks.append(_dump_table_header(path))
            chunks.extend(_dump_inline_pairs(value))
            chunks.append("")
            nested = _dump_nested(path, {k: v for k, v in value.items() if _is_table(v) or _is_array_of_tables(v)})
            chunks.extend(nested)
    return chunks


def dump_toml(doc: dict[str, Any]) -> str:
    if not doc:
        return ""
    lines: list[str] = []
    root_scalars = {k: v for k, v in doc.items() if not _is_table(v) and not _is_array_of_tables(v)}
    for key, value in root_scalars.items():
        lines.append(_dump_pair(key, value))
    if root_scalars:
        lines.append("")
    nested = {k: v for k, v in doc.items() if k not in root_scalars}
    lines.extend(_dump_nested("", nested))
    text = "\n".join(lines).rstrip() + ("\n" if lines else "")
    return text


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------

def _hooks_table(doc: dict[str, Any]) -> dict[str, Any] | None:
    hooks = doc.get("hooks")
    if hooks is None:
        return None
    if not isinstance(hooks, dict):
        raise ValueError("[hooks] must be a table")
    return hooks


def _event_entries(hooks: dict[str, Any], event: str) -> list[dict[str, Any]]:
    raw = hooks.get(event)
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(f"[hooks].{event} must be an array of tables")
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError(f"[hooks].{event} entries must be tables")
        out.append(item)
    return out


def _has_foreign_hook_entries(hooks: dict[str, Any]) -> bool:
    for key, value in hooks.items():
        if key in ("managed_dir", "windows_managed_dir"):
            continue
        if isinstance(value, list):
            for item in value:
                if group_has_foreign(item):
                    return True
        else:
            return True
    return False


def apply_merge(doc: dict[str, Any], plugin_bin: str) -> tuple[dict[str, Any], str]:
    """Return (merged_doc, status). status is 'merged', 'already', or 'skip-foreign-managed_dir'."""
    hooks = _hooks_table(doc)
    if hooks is None:
        merged = dict(doc)
        new_hooks: dict[str, Any] = {"managed_dir": plugin_bin}
        for event in HOOK_EVENTS:
            new_hooks[event] = [our_entry(plugin_bin)]
        merged["hooks"] = new_hooks
        return merged, "merged"

    managed = hooks.get("managed_dir")
    if isinstance(managed, str) and managed.strip() and not managed_dir_is_ours(managed, plugin_bin):
        return doc, "skip-foreign-managed_dir"

    # "already" only when every event carries a NESTED handler group with
    # EXACTLY the current command; anything else (old flat shape, old unquoted
    # form, moved install root) is rebuilt below.
    current = hook_command(plugin_bin)

    def _nested_current(item: Any) -> bool:
        inner = item.get("hooks") if isinstance(item, dict) else None
        return isinstance(inner, list) and any(
            isinstance(h, dict) and h.get("type") == "command" and h.get("command") == current
            for h in inner
        )

    already = True
    for event in HOOK_EVENTS:
        entries = _event_entries(hooks, event)
        if not any(_nested_current(item) for item in entries):
            already = False
            break

    if already:
        return doc, "already"

    new_hooks = dict(hooks)
    if "managed_dir" not in new_hooks or not (
        isinstance(new_hooks.get("managed_dir"), str) and str(new_hooks.get("managed_dir")).strip()
    ):
        if not _has_foreign_hook_entries(hooks):
            new_hooks["managed_dir"] = plugin_bin
    for event in HOOK_EVENTS:
        entries: list[dict[str, Any]] = []
        for item in _event_entries(new_hooks, event):
            if group_is_ours(item):
                stripped, _ = strip_ours(item)
                if stripped is not None:
                    entries.append(stripped)
            else:
                entries.append(item)
        entries.append(our_entry(plugin_bin))
        new_hooks[event] = entries
    merged = dict(doc)
    merged["hooks"] = new_hooks
    return merged, "merged"


def remove_merge(doc: dict[str, Any], plugin_bin: str) -> tuple[dict[str, Any], int]:
    hooks = _hooks_table(doc)
    if hooks is None:
        return doc, 0
    removed = 0
    new_hooks: dict[str, Any] = {}
    for key, value in hooks.items():
        if key in ("managed_dir", "windows_managed_dir"):
            new_hooks[key] = value
            continue
        if not isinstance(value, list):
            new_hooks[key] = value
            continue
        kept: list[Any] = []
        for item in value:
            if isinstance(item, dict) and group_is_ours(item):
                stripped, n = strip_ours(item)
                removed += n
                if stripped is not None:
                    kept.append(stripped)
            else:
                kept.append(item)
        if kept:
            new_hooks[key] = kept
    has_entries = any(k not in ("managed_dir", "windows_managed_dir") for k in new_hooks)
    if managed_dir_is_ours(new_hooks.get("managed_dir"), plugin_bin) and not has_entries:
        new_hooks.pop("managed_dir", None)
    leftover = {k: v for k, v in new_hooks.items() if v not in (None, "", [], {})}
    if not leftover:
        return {k: v for k, v in doc.items() if k != "hooks"}, removed
    merged = dict(doc)
    merged["hooks"] = leftover
    return merged, removed


def parse_existing(text: str, tomllib_mod) -> dict[str, Any]:
    if not text.strip():
        return {}
    try:
        parsed = tomllib_mod.loads(text)
    except Exception as exc:  # tomllib.TOMLDecodeError
        sys.stderr.write(
            f"cannot merge: existing requirements.toml is not valid TOML ({exc}). "
            "Leaving the file untouched. Repair it and re-run.\n"
        )
        sys.stderr.write("--- existing snippet ---\n")
        sys.stderr.write(text[:2000])
        if not text.endswith("\n"):
            sys.stderr.write("\n")
        sys.stderr.write("--- end snippet ---\n")
        raise SystemExit(3) from exc
    if not isinstance(parsed, dict):
        sys.stderr.write(
            "cannot merge: existing requirements.toml did not parse as a table. "
            "Leaving the file untouched.\n"
        )
        raise SystemExit(3)
    return parsed


def validate_roundtrip(text: str, tomllib_mod) -> None:
    try:
        tomllib_mod.loads(text) if text.strip() else {}
    except Exception as exc:
        sys.stderr.write(f"refusing to write invalid TOML: {exc}\n")
        raise SystemExit(1) from exc


def atomic_write(path: str, text: str, tomllib_mod) -> None:
    validate_roundtrip(text, tomllib_mod)
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".requirements-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        with open(tmp, encoding="utf-8") as handle:
            validate_roundtrip(handle.read(), tomllib_mod)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def emit(text: str, out: str | None, tomllib_mod, intended: dict[str, Any] | None = None) -> None:
    if not text.endswith("\n") and text:
        text += "\n"
    validate_roundtrip(text, tomllib_mod)
    if intended is not None:
        reparsed = tomllib_mod.loads(text) if text.strip() else {}
        if reparsed != intended:
            sys.stderr.write(
                "refusing to write: the serialized TOML does not round-trip to the merged "
                "document (key quoting or an unsupported value). Leaving the file untouched.\n"
            )
            raise SystemExit(1)
    if out:
        atomic_write(out, text, tomllib_mod)
    else:
        sys.stdout.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("apply", "remove"))
    parser.add_argument("--plugin-bin", required=True)
    parser.add_argument("--existing", default=None)
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)

    snippet = ""
    try:
        if args.stdin:
            snippet = sys.stdin.read()
            existing_text = snippet
        elif args.existing:
            try:
                with open(args.existing, encoding="utf-8") as handle:
                    existing_text = handle.read()
                    snippet = existing_text
            except FileNotFoundError:
                existing_text = ""
        else:
            existing_text = ""
    except Exception as exc:
        sys.stderr.write(f"cannot read existing TOML: {exc}\n")
        return 1

    tomllib_mod = _load_tomllib()
    if tomllib_mod is None:
        _fail_no_tomllib(snippet)

    try:
        doc = parse_existing(existing_text, tomllib_mod)
    except SystemExit:
        raise
    except Exception as exc:
        sys.stderr.write(f"cannot merge: {exc}\n")
        return 3

    plugin_bin = args.plugin_bin
    try:
        if args.action == "apply":
            merged, status = apply_merge(doc, plugin_bin)
            if status == "skip-foreign-managed_dir":
                managed = (_hooks_table(doc) or {}).get("managed_dir")
                sys.stderr.write(
                    "Skipped managed requirements.toml: foreign managed_dir "
                    f"{managed!r} is set. Rivet capture scripts live outside that "
                    "directory, so they are registered in the user hooks.json only.\n"
                )
                return 2
            text = dump_toml(merged)
            emit(text, args.out, tomllib_mod, merged)
            sys.stderr.write(
                "hooks already present in requirements.toml\n"
                if status == "already"
                else "merged rivet-memory capture hooks into requirements.toml\n"
            )
            return 0
        merged, removed = remove_merge(doc, plugin_bin)
        text = dump_toml(merged)
        emit(text, args.out, tomllib_mod, merged)
        sys.stderr.write(f"removed {removed} rivet-memory hook table(s) from requirements.toml\n")
        return 0
    except SystemExit:
        raise
    except ValueError as exc:
        sys.stderr.write(f"cannot merge: {exc}. Leaving the file untouched.\n")
        return 3
    except Exception as exc:
        sys.stderr.write(f"cannot merge: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
