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

  const session = p.session_id ?? p.sessionId ?? 'unknown'
  const hookEvent = p.hook_event_name ?? p.hookEventName ?? eventArg ?? ''

  // ---- per-session translator state ----
  const stateDir = path.join(os.homedir(), '.cache', 'rivet-den')
  fs.mkdirSync(stateDir, { recursive: true })
  const stateFile = path.join(stateDir, `${session.replace(/[^\w.-]/g, '_')}.json`)
  let st = { started: false, labels: [], done: [], offset: 0 }
  try {
    st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }
  } catch {
    /* fresh session */
  }

  const events = []
  const emit = (body) => events.push({ v: 1, session, name: NAME, harness, ts: Date.now(), ...body })

  if (!st.started) {
    st.started = true
    const title = String(p.prompt ?? path.basename(p.cwd ?? '') ?? 'session').slice(0, 48)
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

  const emitThinking = (thinking) => {
    if (!thinking) return
    // ship the tail of the thought, trimmed to a word boundary — the reducer's
    // sliding window does the rest
    const tail = thinking.replace(/\s+/g, ' ').trim().slice(-260).replace(/^\S*\s+/, '')
    if (tail) emit({ type: 'thinking.delta', text: tail })
  }

  const termLine = (text) => {
    const t = String(text).replace(/[\r\t]/g, ' ').trimEnd().slice(0, 80)
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

  switch (hookEvent) {
    case 'SessionStart':
      break // session.start already emitted above
    case 'UserPromptSubmit': {
      if (p.prompt) emit({ type: 'message.user', text: String(p.prompt).replace(/\s+/g, ' ').trim().slice(0, 300) })
      emit({ type: 'speech.stt', active: true })
      emit({ type: 'speech.stt', active: false }) // reducer lands on 'thinking'
      break
    }
    case 'PreToolUse': {
      if (toolName === 'TodoWrite' || toolName === 'TaskCreate' || toolName === 'TaskUpdate') {
        emit({ type: 'activity', activity: 'writing_plan' })
      } else {
        emitThinking(tailTranscript().thinking)
        emit({ type: 'tool.start', tool: toolName || 'unknown' })
        if (toolName === 'Bash' && p.tool_input?.command) {
          termLine('$ ' + String(p.tool_input.command).replace(/\s+/g, ' '))
        }
      }
      break
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (toolName === 'TodoWrite') {
        handleTodos(p.tool_input?.todos)
      } else {
        if (toolName === 'Bash') {
          const r = p.tool_response
          const out = typeof r === 'string' ? r : [r?.stdout, r?.stderr].filter(Boolean).join('\n')
          for (const l of String(out ?? '').split('\n').filter((l) => l.trim()).slice(-4)) termLine(l)
        } else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName) && p.tool_input?.file_path) {
          termLine('✎ ' + path.basename(p.tool_input.file_path))
        }
        emit({ type: 'tool.end', tool: toolName || undefined })
      }
      break
    }
    case 'PreCompact':
    case 'CompactBefore': {
      // context compaction → nap in the bed until the next event wakes him
      emit({ type: 'thinking.end' })
      emit({ type: 'activity', activity: 'sleeping' })
      break
    }
    case 'Stop':
    case 'TurnAfter': {
      const { thinking, text } = tailTranscript()
      emitThinking(thinking)
      emit({ type: 'thinking.end' })
      const finalText = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 280)
      if (finalText) emit({ type: 'message.agent', text: finalText })
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

  // ---- ship, best-effort, fire-and-forget-ish (bounded) ----
  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  await Promise.allSettled(
    events.map((ev) =>
      fetch(`${DEN_URL}/event`, {
        method: 'POST',
        headers,
        body: JSON.stringify(ev),
        signal: AbortSignal.timeout(1500),
      }),
    ),
  )
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
