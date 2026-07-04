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
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// comma-separated fan-out: each node posts to its OWN den (bare-IP view) and
// to the mesh hub, e.g. "http://127.0.0.1:80,http://10.0.0.1:80"
const DEN_URLS = (process.env.RIVET_DEN_URL ?? 'http://127.0.0.1:5174').split(',').map((u) => u.trim()).filter(Boolean)
const TOKEN = process.env.RIVET_DEN_TOKEN ?? ''
const NAME = process.env.RIVET_DEN_NAME ?? os.hostname()

const args = process.argv.slice(2)
const harness = args.includes('--harness') ? args[args.indexOf('--harness') + 1] : 'claude-code'
const eventArg = args.find((a, i) => i > 0 && args[i - 1] !== '--harness' && !a.startsWith('--'))

async function main() {
  let p
  if (args[0] === '--flush') {
    // detached second pass after a Stop: grok flushes the final
    // agent_message_chunk only AFTER the stop hook exits, so a poll inside
    // the hook can never see it — this re-reads once the writer unblocks
    await new Promise((r) => setTimeout(r, 1500))
    p = { session_id: args[1], transcript_path: args[2], hook_event_name: 'Flush' }
  } else {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    try {
      p = JSON.parse(raw)
    } catch {
      return
    }
  }

  // grok payloads are camelCase and may omit the id entirely — its hook
  // runner exports GROK_SESSION_ID. Last resort: key on parent pid so two
  // concurrent id-less harnesses don't melt into one room.
  const session =
    p.session_id ?? p.sessionId ?? process.env.GROK_SESSION_ID ?? `unknown-${process.ppid}`
  // grok payloads carry snake_case names in hookEventName; normalize to the
  // Claude Code spelling the switch below uses (real events only — the
  // TurnAfter/CompactBefore fakes are gone, don't alias them back in)
  const SNAKE = {
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    post_tool_use_failure: 'PostToolUseFailure',
    pre_compact: 'PreCompact',
    stop: 'Stop',
  }
  const rawEvent = p.hook_event_name ?? p.hookEventName ?? eventArg ?? ''
  const hookEvent = SNAKE[rawEvent] ?? rawEvent
  const toolInput = p.tool_input ?? p.toolInput ?? {}
  const toolResponse = p.tool_response ?? p.toolResult

  // ---- per-session translator state ----
  const stateDir = path.join(os.homedir(), '.cache', 'rivet-den')
  fs.mkdirSync(stateDir, { recursive: true })
  const stateFile = path.join(stateDir, `${session.replace(/[^\w.-]/g, '_')}.json`)
  let st = { started: false, labels: [], done: [], offset: 0, lastSent: '', turnStart: 0, cog: null, taskIds: [] }
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

  // a session only becomes a den room once a human prompt arrives — grok
  // subagent swarms and other promptless sessions would otherwise pile up
  // as ghost rooms in the picker
  if (!st.started) {
    if (hookEvent !== 'UserPromptSubmit') {
      if (hookEvent !== 'Flush') fs.writeFileSync(stateFile, JSON.stringify(st))
      return
    }
    st.started = true
    const title = (
      String(p.prompt ?? path.basename(p.cwd ?? ''))
        .replace(/<\/?user_query>/g, '')
        .trim() || 'session'
    ).slice(0, 48)
    emit({ type: 'session.start', title })
  }

  // ---- transcript tailing: thinking text + latest final answer ----
  const tailTranscript = () => {
    const out = { thinking: '', text: '' }
    let file = p.transcript_path ?? p.transcriptPath
    if (!file) return out
    try {
      // grok's transcriptPath is sometimes the session DIRECTORY, sometimes
      // its updates.jsonl — always tail updates.jsonl so the offset tracks
      // one file consistently
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'updates.jsonl')
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
        // grok updates.jsonl: ACP session updates with streamed chunks —
        // agent_thought_chunk is REAL thinking, agent_message_chunk the reply
        const up = j?.params?.update
        if (up?.sessionUpdate === 'agent_thought_chunk' && up.content?.text) out.thinking += up.content.text
        if (up?.sessionUpdate === 'agent_message_chunk' && up.content?.text) out.text += up.content.text
        // claude-code transcript: assistant message with content blocks
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
      if (p.prompt) {
        const text = String(p.prompt).replace(/<\/?user_query>/g, '').replace(/\r/g, '').trim().slice(0, 2000)
        if (text) emit({ type: 'message.user', text })
      }
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
        // TaskCreate/TaskUpdate (the newer task tools) drive the whiteboard
        // too: the hook keeps its own id→row ledger since, unlike TodoWrite,
        // each call carries only a delta rather than the whole list
        if (toolName === 'TaskCreate') {
          const label = String(toolInput.subject ?? '').slice(0, 60)
          const idMatch = /#(\d+)/.exec(
            typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse ?? ''),
          )
          if (label) {
            st.labels.push(label)
            st.done.push(false)
            st.taskIds.push(idMatch ? idMatch[1] : null)
            emit({ type: 'task.plan', tasks: st.labels })
            st.done.forEach((d, i) => d && emit({ type: 'task.check', index: i }))
          }
        }
        if (toolName === 'TaskUpdate' && toolInput.status === 'completed') {
          const idx = st.taskIds.indexOf(String(toolInput.taskId ?? ''))
          if (idx >= 0 && !st.done[idx]) {
            st.done[idx] = true
            emit({ type: 'task.check', index: idx })
          }
        }
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
      for (let i = 0; i < 6 && !text; i++) {
        await new Promise((r) => setTimeout(r, 250))
        const again = tailTranscript()
        if (again.thinking) thinking += again.thinking
        if (again.text) text = again.text
      }
      if (harness !== 'claude-code') emitThinking(thinking) // no spinner flash right before the bubble closes
      emit({ type: 'thinking.end' })
      emitAgentText(text)
      if (!text) {
        // grok: the final chunk lands only after this hook exits — hand off
        // to a detached flush pass
        const tp = p.transcript_path ?? p.transcriptPath
        if (tp) spawn(process.execPath, [fileURLToPath(import.meta.url), '--flush', session, tp, '--harness', harness], { detached: true, stdio: 'ignore' }).unref()
      }
      break
    }
    case 'Flush': {
      let text = ''
      for (let i = 0; i < 4 && !text; i++) {
        text = tailTranscript().text
        if (!text) await new Promise((r) => setTimeout(r, 500))
      }
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

  // never resurrect state SessionEnd deleted (a detached --flush can land after it)
  if (hookEvent !== 'SessionEnd' && !(hookEvent === 'Flush' && !st.started))
    fs.writeFileSync(stateFile, JSON.stringify(st))

  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  // fan out to every server; per server, one ordered POST /events batch
  // (reduced atomically server-side). 404 = pre-batch server → sequential
  // /event fallback, which still preserves order. First failure per server
  // drops the rest of its batch: later events without predecessors are
  // worse than none.
  if (events.length === 0) return
  await Promise.allSettled(
    DEN_URLS.map(async (base) => {
      try {
        const res = await fetch(`${base}/events`, {
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
        await fetch(`${base}/event`, {
          method: 'POST',
          headers,
          body: JSON.stringify(ev),
          signal: AbortSignal.timeout(1000),
        })
      }
    }),
  )
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
