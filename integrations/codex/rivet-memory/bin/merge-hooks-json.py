#!/usr/bin/env python3
"""Merge or unmerge rivet-memory capture hooks into Codex ~/.codex/hooks.json.

Usage:
  merge-hooks-json.py apply  DEST FRAGMENT PLUGIN_PATH
  merge-hooks-json.py remove DEST PLUGIN_PATH
  merge-hooks-json.py sync   DEST FRAGMENT PLUGIN_PATH managed|user

Never rewrites DEST on parse/shape errors. Command strings are built with
bash single-quote quoting (never raw <PLUGIN_PATH> substitution).
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

MARKER_SCRIPT = "codex-memory-capture.sh"
MARKER_FLAG = "--hook"


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", r"'\''") + "'"


def hook_command(plugin_path: str) -> str:
    script = os.path.join(plugin_path, "bin", MARKER_SCRIPT)
    return f"bash {shell_quote(script)} {MARKER_FLAG}"


def command_is_ours(command: Any) -> bool:
    text = command if isinstance(command, str) else ""
    return MARKER_SCRIPT in text and MARKER_FLAG in text


def die(message: str, dest: str | None = None) -> None:
    extra = f" Leaving {dest} untouched." if dest else ""
    sys.stderr.write(message.rstrip() + extra + "\n")
    raise SystemExit(1)


def load_json_file(path: str, *, missing_ok: bool) -> Any:
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except FileNotFoundError:
        if missing_ok:
            return None
        die(f"error: {path} does not exist.", path)
    except OSError as exc:
        die(f"error: cannot read {path}: {exc}", path)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        die(
            f"error: {path} is not valid JSON ({exc}). Repair the file and re-run.",
            path,
        )


def require_hooks_object(dest_obj: Any, dest: str) -> dict[str, Any]:
    if not isinstance(dest_obj, dict):
        die(f"error: {dest} is not a JSON object. Repair the file and re-run.", dest)
    hooks = dest_obj.get("hooks")
    if hooks is None:
        dest_obj["hooks"] = {}
        hooks = dest_obj["hooks"]
    if not isinstance(hooks, dict) or isinstance(hooks, list):
        die(
            f"error: {dest} has a hooks value that is not an object. "
            "Repair the file and re-run.",
            dest,
        )
    return dest_obj


def inner_has_marker(group: Any) -> bool:
    if not isinstance(group, dict):
        return False
    inner = group.get("hooks")
    if not isinstance(inner, list):
        return False
    return any(isinstance(h, dict) and command_is_ours(h.get("command")) for h in inner)


def event_has_marker(groups: Any) -> bool:
    if not isinstance(groups, list):
        return False
    return any(inner_has_marker(g) for g in groups)


def our_group_from_template(template: Any, command: str) -> dict[str, Any]:
    inner_src = []
    if isinstance(template, dict) and isinstance(template.get("hooks"), list):
        inner_src = template["hooks"]
    if not inner_src:
        inner_src = [{"type": "command", "timeout": 20}]
    inner = []
    for item in inner_src:
        base = dict(item) if isinstance(item, dict) else {}
        base["type"] = base.get("type") or "command"
        base["command"] = command
        if "timeout" not in base:
            base["timeout"] = 20
        inner.append(base)
    return {"hooks": inner}


def apply_merge(dest: str, fragment_path: str, plugin_path: str) -> None:
    command = hook_command(plugin_path)
    fragment = load_json_file(fragment_path, missing_ok=False)
    if not isinstance(fragment, dict):
        die(f"error: {fragment_path} is not a JSON object.")
    dest_obj = load_json_file(dest, missing_ok=True)
    if dest_obj is None:
        dest_obj = {"hooks": {}}
    else:
        dest_obj = require_hooks_object(dest_obj, dest)
    hooks = dest_obj["hooks"]
    added = 0
    for event, groups in (fragment.get("hooks") or {}).items():
        if not isinstance(groups, list):
            continue
        existing_raw = hooks.get(event)
        if existing_raw is None:
            existing = []
        elif not isinstance(existing_raw, list):
            die(
                f"error: {dest} hooks.{event} is not an array. Repair the file and re-run.",
                dest,
            )
        else:
            existing = existing_raw
        if event_has_marker(existing):
            continue
        built = [our_group_from_template(g, command) for g in groups]
        hooks[event] = list(existing) + built
        added += len(built)
    os.makedirs(os.path.dirname(os.path.abspath(dest)) or ".", exist_ok=True)
    with open(dest, "w", encoding="utf-8") as handle:
        json.dump(dest_obj, handle, indent=2)
        handle.write("\n")
    if added:
        print(f"merged {added} hook group(s) into {dest}")
    else:
        print(f"hooks already present in {dest}")


def strip_group(group: Any) -> Any | None:
    if not isinstance(group, dict):
        return group
    inner = group.get("hooks")
    if not isinstance(inner, list):
        return group
    kept = [
        h
        for h in inner
        if not (isinstance(h, dict) and command_is_ours(h.get("command")))
    ]
    if len(kept) == len(inner):
        return group
    if not kept:
        return None
    out = dict(group)
    out["hooks"] = kept
    return out


def sync_user_hooks(
    dest: str, fragment_path: str, plugin_path: str, managed_ok: bool
) -> str:
    """Register-once: managed success strips our user entries; else apply them.

    Returns 'managed' or 'user'. Foreign groups are preserved either way.
    """
    if managed_ok:
        if os.path.isfile(dest):
            remove_merge(dest)
        else:
            print(f"no {dest}")
        return "managed"
    apply_merge(dest, fragment_path, plugin_path)
    return "user"


def remove_merge(dest: str) -> None:
    dest_obj = load_json_file(dest, missing_ok=True)
    if dest_obj is None:
        print(f"no {dest}")
        return
    dest_obj = require_hooks_object(dest_obj, dest)
    hooks = dest_obj["hooks"]
    removed = 0
    for event in list(hooks.keys()):
        existing = hooks[event]
        if not isinstance(existing, list):
            continue
        kept = []
        for group in existing:
            before_inner = (
                len(group.get("hooks") or []) if isinstance(group, dict) else 0
            )
            stripped = strip_group(group)
            if stripped is None:
                inner = group.get("hooks") if isinstance(group, dict) else []
                removed += len(
                    [
                        h
                        for h in inner
                        if isinstance(h, dict) and command_is_ours(h.get("command"))
                    ]
                )
                continue
            after_inner = (
                len(stripped.get("hooks") or []) if isinstance(stripped, dict) else 0
            )
            if isinstance(group, dict) and after_inner < before_inner:
                removed += before_inner - after_inner
            kept.append(stripped)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    with open(dest, "w", encoding="utf-8") as handle:
        json.dump(dest_obj, handle, indent=2)
        handle.write("\n")
    print(f"removed {removed} hook command(s) from {dest}")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] not in ("apply", "remove", "sync"):
        sys.stderr.write(
            "usage: merge-hooks-json.py apply DEST FRAGMENT PLUGIN_PATH\n"
            "       merge-hooks-json.py remove DEST PLUGIN_PATH\n"
            "       merge-hooks-json.py sync DEST FRAGMENT PLUGIN_PATH managed|user\n"
        )
        return 1
    action = args[0]
    try:
        if action == "apply":
            if len(args) != 4:
                die("usage: merge-hooks-json.py apply DEST FRAGMENT PLUGIN_PATH")
            apply_merge(args[1], args[2], args[3])
            return 0
        if action == "sync":
            if len(args) != 5 or args[4] not in ("managed", "user"):
                die(
                    "usage: merge-hooks-json.py sync DEST FRAGMENT PLUGIN_PATH managed|user"
                )
            mode = sync_user_hooks(args[1], args[2], args[3], args[4] == "managed")
            print(f"registration: {mode}")
            return 0
        if len(args) != 3:
            die("usage: merge-hooks-json.py remove DEST PLUGIN_PATH")
        remove_merge(args[1])
        return 0
    except SystemExit as exc:
        code = exc.code
        return int(code) if isinstance(code, int) else 1


if __name__ == "__main__":
    raise SystemExit(main())
