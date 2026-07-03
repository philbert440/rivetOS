#!/usr/bin/env node
// rivet-den hook translator: one Claude Code (or Grok Build) lifecycle hook
// payload on stdin → rivet-den protocol v1 events → POST /event on den-server.
//
// Self-contained (no deps, no rivetos install needed) — this same file is the
// hosted-tier onboarding artifact. Grok Build reuses it via its shim with
// `--harness grok-build [EventName]` since grok payloads may omit the event.
//
// Config (env):
//   RIVET_DEN_URL    den-server base (default http://127.0.0.1:5174)
//   RIVET_DEN_TOKEN  bearer token, when the server has auth on
//   RIVET_DEN_NAME   session display name (default: os hostname)
//
// Per-session translator state (todo diff, transcript offset, started flag)
// lives under ~/.cache/rivet-den/. Everything is best-effort: exit 0 always.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEN_URL = process.env.RIVET_DEN_URL ?? 'http://127.0.0.1:5174'
const TOKEN = process.env.RIVET_DEN_TOKEN ?? ''
const NAME = process.env.RIVET_DEN_NAME ?? os.hostname()

const args = process.argv.slice(2)
const harness = args.includes('--harness') ? args[args.indexOf('--harness') + 1] : 'claude-code'
const eventArg = args.find((a, i) => i > 0 && args[i - 1] !== '--harness' && !a.startsWith('--'))

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let p
  try {
    p = JSON.parse(raw)
  } catch {
    return
  }

  // grok payloads are camelCase and may omit the id entirely — its hook
  // runner exports GROK_SESSION_ID. Last resort: key on parent pid so two
  // concurrent id-less harnesses don't melt into one room.
  const session =
    p.session_id ?? p.sessionId ?? process.env.GROK_SESSION_ID ?? `unknown-${process.ppid}`
  const hookEvent = p.hook_event_name ?? p.hookEventName ?? eventArg ?? ''
  const toolInput = p.tool_input ?? p.toolInput ?? {}
  const toolResponse = p.tool_response ?? p.toolResult

  // ---- per-session translator state ----
  const stateDir = path.join(os.homedir(), '.cache', 'rivet-den')
  fs.mkdirSync(stateDir, { recursive: true })
  const stateFile = path.join(stateDir, `${session.replace(/[^\w.-]/g, '_')}.json`)
  let st = { started: false, labels: [], done: [], offset: 0, lastSent: '', turnStart: 0, cog: null }
  try {
    st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }
  } catch {
    /* fresh session */
  }

  const events = []
  // ts ticks up per event so a batch keeps its order through the reducer's
  // monotonic lastEventTs even though it's emitted within one millisecond
  const emit = (body) =>
    events.push({ v: 1, session, name: NAME, harness, ts: Date.now() + events.length, ...body })

  if (!st.started) {
    st.started = true
    const title = (String(p.prompt ?? path.basename(p.cwd ?? '')).trim() || 'session').slice(0, 48)
    emit({ type: 'session.start', title })
  }

  // ---- transcript tailing: thinking text + latest final answer ----
  const tailTranscript = () => {
    const out = { thinking: '', text: '' }
    const file = p.transcript_path ?? p.transcriptPath
    if (!file) return out
    try {
      const stat = fs.statSync(file)
      if (stat.size <= st.offset) return out
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(stat.size - st.offset)
      fs.readSync(fd, buf, 0, buf.length, st.offset)
      fs.closeSync(fd)
      st.offset = stat.size
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        let j
        try {
          j = JSON.parse(line)
        } catch {
          continue
        }
        const content = j?.message?.content
        if (j.type !== 'assistant' || !Array.isArray(content)) continue
        st.turnTokens = (st.turnTokens ?? 0) + (j.message?.usage?.output_tokens ?? 0)
        for (const block of content) {
          if (block.type === 'thinking' && block.thinking) out.thinking += block.thinking
          if (block.type === 'text' && block.text) out.text = block.text
        }
      }
    } catch {
      /* transcript unreadable — skip */
    }
    return out
  }

  // Claude Code doesn't expose real thinking text to hooks, so the bubble
  // gets a spinner word in the Anthropic CLI style instead of transcript tail
  const COGS = ['Cogitating', 'Pondering', 'Ruminating', 'Noodling', 'Percolating', 'Mulling', 'Scheming', 'Brewing', 'Synthesizing', 'Marinating', 'Puzzling', 'Tinkering', 'Architecting', 'Wrangling']
  const GLYPHS = ['✳', '✢', '✻', '✽']
  const emitThinking = (thinking) => {
    if (harness === 'claude-code') {
      // one spinner word per turn (picked at turn start), live elapsed time +
      // output-token count — mirrors the Anthropic CLI's status line, e.g.
      // "✢ Architecting… (1m 22s · ↓ 4.8k tokens)"
      const secs = st.turnStart ? Math.max(0, Math.round((Date.now() - st.turnStart) / 1000)) : 0
      const dur = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
      const tok = st.turnTokens ?? 0
      const tokStr = tok >= 1000 ? `${(tok / 1000).toFixed(1)}k` : String(tok)
      const word = st.cog ?? COGS[Math.floor(Math.random() * COGS.length)]
      const glyph = GLYPHS[secs % GLYPHS.length]
      emit({ type: 'thinking.delta', text: `${glyph} ${word}… (${dur} · ↓ ${tokStr} tokens)` })
      return
    }
    if (!thinking) return
    // ship the tail of the thought, trimmed to a word boundary — the reducer's
    // sliding window does the rest
    const tail = thinking.replace(/\s+/g, ' ').trim().slice(-260).replace(/^\S*\s+/, '')
    if (tail) emit({ type: 'thinking.delta', text: tail })
  }

  // Terminal lines mirror REAL command/output text onto a den anyone with
  // access to the server can watch. RIVET_DEN_TERM=off disables them
  // entirely; otherwise redact() catches the obvious secret shapes. This is
  // best-effort, not a guarantee — the real control is who can reach the
  // den-server (see README).
  const TERM_OFF = (process.env.RIVET_DEN_TERM ?? '') === 'off'
  const redact = (s) =>
    s
      // Authorization / Bearer headers FIRST (the key=/: rule below would
      // otherwise consume the word "Bearer" and leave the token standing)
      .replace(/\b(bearer|basic)\s+[\w+./=-]{8,}/gi, '$1 [redacted]')
      // KEY=value / key: value where the key names a credential
      .replace(/\b([\w-]*(?:key|token|secret|passw(?:or)?d|credential|auth)[\w-]*\s*[=:]\s*)\S+/gi, '$1[redacted]')
      // well-known token prefixes (AWS, GitHub, Slack, OpenAI/Stripe-style) + bare JWTs
      .replace(/\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[a-z]-[\w-]{10,}|sk-[A-Za-z0-9_-]{16,}|eyJ[\w-]{8,}\.[\w-]+\.[\w-]+)\b/g, '[redacted]')

  // every discovered assistant text block goes to the chat stream, deduped —
  // mid-turn status notes (PreToolUse) as well as the final answer (Stop)
  const emitAgentText = (text) => {
    // keep newlines/indentation — the chat panel wraps and renders them now
    const t = String(text ?? '').replace(/\r/g, '').trim().slice(0, 2000)
    if (!t || t === st.lastSent) return
    st.lastSent = t
    emit({ type: 'message.agent', text: t })
  }

  const termLine = (text) => {
    if (TERM_OFF) return
    const t = redact(String(text).replace(/[\r\t]/g, ' ').trimEnd()).slice(0, 80)
    if (t.trim()) emit({ type: 'term.line', text: t })
  }

  const handleTodos = (todos) => {
    if (!Array.isArray(todos) || !todos.length) return
    const labels = todos.map((t) => String(t.content ?? t.activeForm ?? '').slice(0, 60))
    const done = todos.map((t) => t.status === 'completed')
    const sameList = labels.length === st.labels.length && labels.every((l, i) => l === st.labels[i])
    if (!sameList) {
      emit({ type: 'task.plan', tasks: labels })
      done.forEach((d, i) => d && emit({ type: 'task.check', index: i }))
    } else {
      done.forEach((d, i) => {
        if (d && !st.done[i]) emit({ type: 'task.check', index: i })
      })
    }
    st.labels = labels
    st.done = done
  }

  const toolName = p.tool_name ?? p.toolName ?? ''
  // planning tools drive the whiteboard instead of tool.start/tool.end —
  // PreToolUse and PostToolUse must agree on this set or the room gets a
  // tool.end with no matching tool.start
  const isPlanningTool = /^(TodoWrite|TaskCreate|TaskUpdate)$/.test(toolName)
  // grok aliases Claude-style names: Bash→run_terminal_cmd, Edit→search_replace
  const isShellTool = toolName === 'Bash' || toolName === 'run_terminal_cmd'
  const isEditTool = /^(Edit|Write|MultiEdit|NotebookEdit|search_replace|write_file)$/.test(
    toolName,
  )

  switch (hookEvent) {
    case 'SessionStart':
      break // session.start already emitted above
    case 'UserPromptSubmit': {
      if (p.prompt) emit({ type: 'message.user', text: String(p.prompt).replace(/\r/g, '').trim().slice(0, 2000) })
      emit({ type: 'speech.stt', active: true })
      emit({ type: 'speech.stt', active: false }) // reducer lands on 'thinking'
      st.turnStart = Date.now()
      st.turnTokens = 0
      st.cog = COGS[Math.floor(Math.random() * COGS.length)]
      emitThinking('') // claude-code: put the spinner word in the bubble now
      break
    }
    case 'PreToolUse': {
      if (isPlanningTool) {
        emit({ type: 'activity', activity: 'writing_plan' })
      } else {
        const tt = tailTranscript()
        emitThinking(tt.thinking)
        emitAgentText(tt.text)
        emit({ type: 'tool.start', tool: toolName || 'unknown' })
        if (isShellTool && toolInput.command) {
          termLine('$ ' + String(toolInput.command).replace(/\s+/g, ' '))
        }
      }
      break
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (isPlanningTool) {
        // no tool.start was emitted for these — no tool.end either
        if (toolName === 'TodoWrite') handleTodos(toolInput.todos)
      } else {
        if (isShellTool) {
          const r = toolResponse
          const out = typeof r === 'string' ? r : [r?.stdout, r?.stderr].filter(Boolean).join('\n')
          for (const l of String(out ?? '').split('\n').filter((l) => l.trim()).slice(-4)) termLine(l)
        } else if (isEditTool && (toolInput.file_path ?? toolInput.filePath)) {
          termLine('✎ ' + path.basename(toolInput.file_path ?? toolInput.filePath))
        }
        emit({ type: 'tool.end', tool: toolName || undefined })
      }
      break
    }
    case 'PreCompact': {
      // context compaction → nap in the bed until the next event wakes him
      emit({ type: 'thinking.end' })
      emit({ type: 'activity', activity: 'sleeping' })
      break
    }
    case 'Stop': {
      // Claude Code fires Stop BEFORE the final assistant message is flushed
      // to the transcript jsonl — for a quick no-tool reply the first tail
      // reads nothing, so poll briefly for the late write (hook timeout is 5s)
      let { thinking, text } = tailTranscript()
      for (let i = 0; i < 10 && !text; i++) {
        await new Promise((r) => setTimeout(r, 250))
        const again = tailTranscript()
        if (again.thinking) thinking += again.thinking
        if (again.text) text = again.text
      }
      if (harness !== 'claude-code') emitThinking(thinking) // no spinner flash right before the bubble closes
      emit({ type: 'thinking.end' })
      emitAgentText(text)
      break
    }
    case 'SessionEnd': {
      emit({ type: 'session.end' })
      try {
        fs.unlinkSync(stateFile)
      } catch {
        /* already gone */
      }
      break
    }
    default:
      break
  }

  if (hookEvent !== 'SessionEnd') fs.writeFileSync(stateFile, JSON.stringify(st))

  // ---- ship, best-effort, bounded: one ordered batch to /events (reduced
  // atomically server-side). 404 = pre-batch server → fall back to
  // sequential /event posts, which preserve order at one round trip each.
  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  if (events.length === 0) return
  try {
    const res = await fetch(`${DEN_URL}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(1500),
    })
    if (res.status !== 404) return
  } catch {
    return // server unreachable — retrying event-by-event won't help
  }
  for (const ev of events) {
    try {
      await fetch(`${DEN_URL}/event`, {
        method: 'POST',
        headers,
        body: JSON.stringify(ev),
        signal: AbortSignal.timeout(1000),
      })
    } catch {
      break
    }
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
