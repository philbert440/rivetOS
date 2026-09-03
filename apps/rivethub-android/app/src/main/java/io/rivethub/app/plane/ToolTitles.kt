package io.rivethub.app.plane

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Human-readable titles for harness tool names (Claude Code + Grok Build).
 * Port of rivethub-web `lib/tool-titles.ts`.
 */

fun toolArgStrings(args: JsonObject?): Map<String, String> {
    if (args == null) return emptyMap()
    val out = LinkedHashMap<String, String>()
    for ((k, v) in args) {
        val p = v as? JsonPrimitive ?: continue
        if (!p.isString) continue
        val s = p.contentOrNull?.trim().orEmpty()
        if (s.isNotEmpty()) out[k] = s
    }
    return out
}

// normalizeToolName lives in AskUser.kt (same package) — one definition.

private fun arg(args: Map<String, String>, key: String): String? =
    args[key]?.takeIf { it.isNotBlank() }

private fun basename(path: String?): String? {
    if (path.isNullOrEmpty()) return null
    val parts = path.split('/', '\\')
    return parts.lastOrNull()?.ifEmpty { path } ?: path
}

fun humanToolTitle(rawName: String, args: Map<String, String> = emptyMap()): String {
    val name = normalizeToolName(rawName)
    val lower = name.lowercase()

    if (name == "Bash" || lower == "bash" || lower == "shell") {
        val d = arg(args, "description") ?: arg(args, "command")?.take(48)
        return if (d != null) "Ran: $d" else "Ran a command"
    }
    if (name == "Edit" || name == "NotebookEdit") {
        return "Edited ${basename(arg(args, "file_path")) ?: "file"}"
    }
    if (name == "Write") {
        return "Wrote ${basename(arg(args, "file_path")) ?: "file"}"
    }
    if (name == "Read") {
        return "Read ${basename(arg(args, "file_path")) ?: "file"}"
    }
    if (name == "Grep" || name == "Glob") {
        val p = arg(args, "pattern").orEmpty()
        return if (p.isNotEmpty()) "Searched: $p" else "Searched files"
    }
    if (name == "WebFetch") {
        return "Fetched ${arg(args, "url") ?: "page"}"
    }
    if (name == "WebSearch") {
        return "Searched web: ${arg(args, "query").orEmpty()}"
    }
    if (name == "Task") {
        return "Subagent: ${arg(args, "description") ?: "task"}"
    }
    if (name == "AskUserQuestion") {
        return "Asked a question"
    }

    if (lower == "run_terminal_command" || lower == "run_terminal_cmd") {
        val d = arg(args, "description") ?: arg(args, "command")?.take(48)
        return if (d != null) "Ran: $d" else "Ran a command"
    }
    if (lower == "read_file") {
        return "Read ${basename(arg(args, "path") ?: arg(args, "file_path")) ?: "file"}"
    }
    if (lower == "search_replace" || lower == "edit_file" || lower == "apply_patch") {
        return "Edited ${basename(arg(args, "path") ?: arg(args, "file_path")) ?: "file"}"
    }
    if (lower == "write_file" || lower == "create_file") {
        return "Wrote ${basename(arg(args, "path") ?: arg(args, "file_path")) ?: "file"}"
    }
    if (lower == "grep" || lower == "glob" || lower == "find_files" || lower == "list_dir") {
        val p = arg(args, "pattern") ?: arg(args, "query") ?: arg(args, "path").orEmpty()
        return if (p.isNotEmpty()) "Searched: $p" else "Searched files"
    }
    if (lower == "web_search") {
        return "Searched web: ${arg(args, "query").orEmpty()}"
    }
    if (lower == "web_fetch") {
        return "Fetched ${arg(args, "url") ?: "page"}"
    }
    if (lower == "todo_write") {
        return "Updated task list"
    }
    if (lower == "ask_user_question" || lower == "ask_user") {
        return "Asked a question"
    }

    if (name.contains(':')) {
        val last = name.substringAfterLast(':')
        return last.replace('_', ' ')
    }
    if (name.contains("__")) {
        val last = name.substringAfterLast("__")
        return last.replace('_', ' ')
    }
    return name.replace('_', ' ')
}
