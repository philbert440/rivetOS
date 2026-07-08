/**
 * Human-readable titles for harness tool names (Claude Code + Grok Build).
 * Behavior ported from Android ChatMessageTools (display-only; not the APK).
 */

export type ToolArgs = Record<string, unknown> | undefined

function str(args: ToolArgs, key: string): string | undefined {
  if (!args) return undefined
  const v = args[key]
  return typeof v === 'string' && v.trim() ? v : undefined
}

function basename(path: string | undefined): string | undefined {
  if (!path) return undefined
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/** Strip emoji / status prefixes from stream content ("🔧 shell" → "shell"). */
export function normalizeToolName(raw: string): string {
  const t = raw.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\s✅❌🔧]+/u, '').trim()
  return t || raw.trim() || 'tool'
}

/**
 * Human title for a tool invocation. Unknown names fall back to a short form
 * of the raw name (not empty).
 */
export function humanToolTitle(rawName: string, args?: ToolArgs): string {
  const name = normalizeToolName(rawName)
  const lower = name.toLowerCase()

  // Claude Code
  if (name === 'Bash' || lower === 'bash' || lower === 'shell') {
    const d = str(args, 'description') ?? str(args, 'command')?.slice(0, 48)
    return d ? `Ran: ${d}` : 'Ran a command'
  }
  if (name === 'Edit' || name === 'NotebookEdit') {
    return `Edited ${basename(str(args, 'file_path')) ?? 'file'}`
  }
  if (name === 'Write') {
    return `Wrote ${basename(str(args, 'file_path')) ?? 'file'}`
  }
  if (name === 'Read') {
    return `Read ${basename(str(args, 'file_path')) ?? 'file'}`
  }
  if (name === 'Grep' || name === 'Glob') {
    const p = str(args, 'pattern') ?? ''
    return p ? `Searched: ${p}` : 'Searched files'
  }
  if (name === 'WebFetch') {
    return `Fetched ${str(args, 'url') ?? 'page'}`
  }
  if (name === 'WebSearch') {
    return `Searched web: ${str(args, 'query') ?? ''}`
  }
  if (name === 'Task') {
    return `Subagent: ${str(args, 'description') ?? 'task'}`
  }
  if (name === 'AskUserQuestion') {
    return 'Asked a question'
  }

  // Grok Build / common agent tools
  if (lower === 'run_terminal_command' || lower === 'run_terminal_cmd') {
    const d = str(args, 'description') ?? str(args, 'command')?.slice(0, 48)
    return d ? `Ran: ${d}` : 'Ran a command'
  }
  if (lower === 'read_file') {
    return `Read ${basename(str(args, 'path') ?? str(args, 'file_path')) ?? 'file'}`
  }
  if (lower === 'search_replace' || lower === 'edit_file' || lower === 'apply_patch') {
    return `Edited ${basename(str(args, 'path') ?? str(args, 'file_path')) ?? 'file'}`
  }
  if (lower === 'write_file' || lower === 'create_file') {
    return `Wrote ${basename(str(args, 'path') ?? str(args, 'file_path')) ?? 'file'}`
  }
  if (lower === 'grep' || lower === 'glob' || lower === 'find_files' || lower === 'list_dir') {
    const p = str(args, 'pattern') ?? str(args, 'query') ?? str(args, 'path') ?? ''
    return p ? `Searched: ${p}` : 'Searched files'
  }
  if (lower === 'web_search') {
    return `Searched web: ${str(args, 'query') ?? ''}`
  }
  if (lower === 'web_fetch') {
    return `Fetched ${str(args, 'url') ?? 'page'}`
  }
  if (lower === 'todo_write') {
    return 'Updated task list'
  }
  if (lower === 'ask_user_question' || lower === 'ask_user') {
    return 'Asked a question'
  }

  // MCP-style "mcp:server:tool" → last segment
  if (name.includes(':')) {
    const last = name.split(':').pop() ?? name
    return last.replace(/_/g, ' ')
  }

  return name.replace(/_/g, ' ')
}
