import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import {
  agentMessageText,
  buildArgs,
  buildChildEnv,
  CodexCliModel,
  CodexCliProvider,
  defaultSkipGitRepoCheck,
  eventFailureMessage,
  parseCodexLine,
  renderPrompt,
  resumePrompt,
  usageFromEvent,
  type CodexCliModelConfig,
} from './index.js'
import { loadSessionMap } from './session-map.js'

const prompt: LanguageModelV3Prompt = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  { role: 'user', content: [{ type: 'text', text: 'again' }] },
]

function fakeCodex(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'codex-cli-')), 'codex')
  writeFileSync(path, body, { mode: 0o755 })
  return path
}

function config(
  binary: string,
  sessionMapPath = join(mkdtempSync(join(tmpdir(), 'codex-map-')), 'map.json'),
  extra: Partial<CodexCliModelConfig> = {},
): CodexCliModelConfig {
  return {
    providerId: 'codex-cli',
    binary,
    modelId: 'default',
    sandbox: 'read-only',
    approveForMe: false,
    skipGitRepoCheck: true,
    sessionMode: 'resume',
    conversationId: 'c1',
    sessionMapPath,
    ...extra,
  }
}

async function collect(
  model: CodexCliModel,
  input: LanguageModelV3Prompt = prompt,
): Promise<LanguageModelV3StreamPart[]> {
  const { stream } = await model.doStream({ prompt: input })
  const reader = stream.getReader()
  const out: LanguageModelV3StreamPart[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return pred()
}

const HEALTHY = `#!/usr/bin/env bash
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-1"}' '{"type":"item.completed","item":{"type":"agent_message","text":"hello from Codex"}}' '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":2,"output_tokens":4,"reasoning_output_tokens":1}}'
`

describe('Codex CLI protocol', () => {
  it('builds new and resumed exec invocations safely', () => {
    expect(
      buildArgs({
        binary: 'codex',
        sandbox: 'read-only',
        approveForMe: false,
        skipGitRepoCheck: true,
      }),
    ).toEqual(['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-'])
    expect(
      buildArgs({
        binary: 'codex',
        sandbox: 'workspace-write',
        approveForMe: true,
        skipGitRepoCheck: false,
        sessionId: 'thread-1',
        modelId: 'gpt-x',
        reasoningEffort: 'xhigh',
        cwd: '/work',
      }),
    ).toEqual([
      'exec',
      'resume',
      'thread-1',
      '--json',
      '-s',
      'workspace-write',
      '--approve-for-me',
      '-C',
      '/work',
      '-m',
      'gpt-x',
      '-c',
      'model_reasoning_effort=xhigh',
      '-',
    ])
  })

  it('renders the full transcript for a fresh thread', () => {
    expect(renderPrompt(prompt)).toContain('SYSTEM:\nYou are helpful.')
    expect(renderPrompt(prompt)).toContain('ASSISTANT:\nhi')
    expect(renderPrompt(prompt)).toContain('USER:\nagain')
  })

  it('re-prepends SYSTEM text on resume, including trailing steers', () => {
    expect(resumePrompt(prompt)).toContain('SYSTEM:\nYou are helpful.')
    expect(resumePrompt(prompt)).toContain('again')
    expect(resumePrompt(prompt)).not.toContain('hello')
    const steered: LanguageModelV3Prompt = [...prompt, { role: 'system', content: 'stop and do X' }]
    expect(resumePrompt(steered)).toContain('stop and do X')
    expect(resumePrompt(steered)).toContain('again')
  })

  it('parses events and usage', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"t1"}')).toEqual({
      type: 'thread.started',
      thread_id: 't1',
    })
    expect(parseCodexLine('noise')).toBeNull()
    const usage = usageFromEvent({
      type: 'turn.completed',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 30,
        cache_write_input_tokens: 10,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    })
    expect(usage.inputTokens.noCache).toBe(60)
    expect(usage.outputTokens.text).toBe(15)
    const clamped = usageFromEvent({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 40,
        output_tokens: 3,
        reasoning_output_tokens: 9,
      },
    })
    expect(clamped.inputTokens.noCache).toBe(0)
    expect(clamped.outputTokens.text).toBe(0)
  })

  it('treats only completed agent_message items as reply text', () => {
    expect(
      agentMessageText({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello' },
      }),
    ).toBe('hello')
    expect(
      agentMessageText({
        type: 'item.updated',
        item: { type: 'agent_message', text: 'hel' },
      }),
    ).toBeUndefined()
    expect(
      agentMessageText({
        type: 'item.completed',
        item: { type: 'command_execution', text: 'ls -la' },
      }),
    ).toBeUndefined()
    expect(
      agentMessageText({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'thinking…' },
      }),
    ).toBeUndefined()
  })

  it('extracts protocol failure text from error and turn.failed events', () => {
    expect(eventFailureMessage({ type: 'error', message: 'not logged in' })).toBe('not logged in')
    expect(eventFailureMessage({ type: 'error', error: { message: 'nope' } })).toBe('nope')
    expect(eventFailureMessage({ type: 'turn.failed', error: { message: 'thread gone' } })).toBe(
      'thread gone',
    )
    expect(
      eventFailureMessage({
        type: 'item.completed',
        item: { type: 'error', message: 'sandbox denied' },
      }),
    ).toBeUndefined()
    expect(eventFailureMessage({ type: 'turn.completed' })).toBeUndefined()
  })

  it('defaults skip_git_repo_check to the sandbox', () => {
    expect(defaultSkipGitRepoCheck('read-only')).toBe(true)
    expect(defaultSkipGitRepoCheck('workspace-write')).toBe(false)
    expect(defaultSkipGitRepoCheck('danger-full-access')).toBe(false)
    expect(defaultSkipGitRepoCheck('workspace-write', true)).toBe(true)
    expect(defaultSkipGitRepoCheck('read-only', false)).toBe(false)
  })

  it('scrubs every OPENAI_* key from the child env', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/rivet',
      OPENAI_API_KEY: 'sk-nope',
      OPENAI_BASE_URL: 'https://example.invalid',
      OPENAI_MODEL: 'gpt-x',
      CODEX_HOME: '/home/rivet/.codex',
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OPENAI_BASE_URL).toBeUndefined()
    expect(env.OPENAI_MODEL).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CODEX_HOME).toBe('/home/rivet/.codex')
  })

  it('streams agent messages, records the thread and reports usage', async () => {
    const binary = fakeCodex(HEALTHY)
    const map = join(mkdtempSync(join(tmpdir(), 'codex-map-')), 'map.json')
    const parts = await collect(new CodexCliModel(config(binary, map)))
    expect(parts.map((p) => p.type)).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
    expect(parts.find((p) => p.type === 'text-delta')).toMatchObject({ delta: 'hello from Codex' })
    expect(loadSessionMap(map)).toEqual({ c1: 'thread-1' })
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({
      usage: { inputTokens: { total: 12 }, outputTokens: { total: 4 } },
    })
  })

  it('resumes with SYSTEM block plus the newest user input', async () => {
    const binary = fakeCodex(
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "${CODEX_ARGS_FILE}"\ncat > "${CODEX_PROMPT_FILE}"\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\' \'{"type":"turn.completed","usage":{}}\'\n',
    )
    const dir = mkdtempSync(join(tmpdir(), 'codex-resume-'))
    const map = join(dir, 'map.json')
    writeFileSync(map, '{"c1":"thread-old"}')
    const oldArgs = process.env.CODEX_ARGS_FILE
    const oldPrompt = process.env.CODEX_PROMPT_FILE
    process.env.CODEX_ARGS_FILE = join(dir, 'args')
    process.env.CODEX_PROMPT_FILE = join(dir, 'prompt')
    try {
      await collect(new CodexCliModel(config(binary, map)))
      expect(readFileSync(process.env.CODEX_ARGS_FILE!, 'utf8')).toContain('resume\nthread-old')
      expect(readFileSync(process.env.CODEX_PROMPT_FILE!, 'utf8')).toBe(
        'SYSTEM:\nYou are helpful.\n\n---\n\nagain',
      )
    } finally {
      if (oldArgs === undefined) delete process.env.CODEX_ARGS_FILE
      else process.env.CODEX_ARGS_FILE = oldArgs
      if (oldPrompt === undefined) delete process.env.CODEX_PROMPT_FILE
      else process.env.CODEX_PROMPT_FILE = oldPrompt
    }
  })

  it('survives a stdin error (EPIPE) from a child that exits without reading the prompt', async () => {
    // A fake child whose stdin emits 'error' — with no listener a stream's
    // emit('error') THROWS synchronously, so this test fails on revert.
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      exitCode: number | null
      signalCode: string | null
      killed: boolean
      kill: () => boolean
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.kill = () => true
    const spawnImpl = ((): typeof child => {
      queueMicrotask(() => {
        child.stderr.write('not logged in\n')
        const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        child.stdin.emit('error', err)
        child.exitCode = 3
        child.emit('close', 3)
      })
      return child
    }) as unknown as typeof spawn
    const parts = await collect(new CodexCliModel({ ...config('/nonexistent/codex'), spawnImpl }), [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(110_000) }] },
    ])
    const error = parts.find((p) => p.type === 'error') as { error: Error } | undefined
    expect(error?.error.message).toBe('not logged in') // the cause, not the EPIPE symptom
    expect(parts.some((p) => p.type === 'finish')).toBe(true)
  })

  it('kills the child when the stream reader is cancelled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-cancel-'))
    const pidfile = join(dir, 'pid')
    const sentinel = join(dir, 'survived')
    const oldPid = process.env.CODEX_TEST_PIDFILE
    const oldSentinel = process.env.CODEX_TEST_SENTINEL
    process.env.CODEX_TEST_PIDFILE = pidfile
    process.env.CODEX_TEST_SENTINEL = sentinel
    const binary = fakeCodex(
      '#!/usr/bin/env bash\necho $$ > "$CODEX_TEST_PIDFILE"\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"hello from Codex"}}\'\nexec sleep 30\necho survived > "$CODEX_TEST_SENTINEL"\n',
    )
    try {
      const { stream } = await new CodexCliModel(config(binary)).doStream({ prompt })
      const reader = stream.getReader()
      expect(await waitFor(() => existsSync(pidfile))).toBe(true)
      await reader.read()
      await reader.cancel()
      const pid = Number(readFileSync(pidfile, 'utf8').trim())
      expect(Number.isInteger(pid) && pid > 0).toBe(true)
      expect(await waitFor(() => !pidAlive(pid), 4000)).toBe(true)
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      if (oldPid === undefined) delete process.env.CODEX_TEST_PIDFILE
      else process.env.CODEX_TEST_PIDFILE = oldPid
      if (oldSentinel === undefined) delete process.env.CODEX_TEST_SENTINEL
      else process.env.CODEX_TEST_SENTINEL = oldSentinel
    }
  })

  it('scrubs OPENAI_API_KEY from the child environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-env-'))
    const envFile = join(dir, 'key')
    const oldKey = process.env.OPENAI_API_KEY
    const oldFile = process.env.CODEX_ENV_FILE
    process.env.OPENAI_API_KEY = 'sk-should-not-leak'
    process.env.CODEX_ENV_FILE = envFile
    const binary = fakeCodex(
      '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'%s\' "$OPENAI_API_KEY" > "$CODEX_ENV_FILE"\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\' \'{"type":"turn.completed","usage":{}}\'\n',
    )
    try {
      await collect(new CodexCliModel(config(binary)))
      expect(readFileSync(envFile, 'utf8')).toBe('')
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = oldKey
      if (oldFile === undefined) delete process.env.CODEX_ENV_FILE
      else process.env.CODEX_ENV_FILE = oldFile
    }
  })

  it('still delivers the reply when the session map cannot be saved', async () => {
    const binary = fakeCodex(HEALTHY)
    const dir = mkdtempSync(join(tmpdir(), 'codex-ro-'))
    chmodSync(dir, 0o500)
    const map = join(dir, 'map.json')
    try {
      const parts = await collect(new CodexCliModel(config(binary, map)))
      expect(parts.find((p) => p.type === 'text-delta')).toMatchObject({
        delta: 'hello from Codex',
      })
      expect(parts.some((p) => p.type === 'finish')).toBe(true)
      expect(parts.some((p) => p.type === 'error')).toBe(false)
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('drops a dead resume thread from the map and keeps the original error', async () => {
    const binary = fakeCodex(
      '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"turn.failed","error":{"message":"thread thread-gone not found"}}\'\nexit 1\n',
    )
    const dir = mkdtempSync(join(tmpdir(), 'codex-dead-'))
    const map = join(dir, 'map.json')
    writeFileSync(map, '{"c1":"thread-gone"}')
    const parts = await collect(new CodexCliModel(config(binary, map)))
    expect(loadSessionMap(map)).toEqual({})
    const errPart = parts.find((p) => p.type === 'error')
    expect(errPart?.type === 'error' ? String(errPart.error) : '').toContain(
      'thread thread-gone not found',
    )
  })

  it('keeps both session-map entries when two conversations start concurrently', async () => {
    const map = join(mkdtempSync(join(tmpdir(), 'codex-race-')), 'map.json')
    const binA = fakeCodex(
      '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"tA"}\' \'{"type":"item.completed","item":{"type":"agent_message","text":"A"}}\' \'{"type":"turn.completed","usage":{}}\'\n',
    )
    const binB = fakeCodex(
      '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"tB"}\' \'{"type":"item.completed","item":{"type":"agent_message","text":"B"}}\' \'{"type":"turn.completed","usage":{}}\'\n',
    )
    await Promise.all([
      collect(new CodexCliModel(config(binA, map, { conversationId: 'convA' }))),
      collect(new CodexCliModel(config(binB, map, { conversationId: 'convB' }))),
    ])
    expect(loadSessionMap(map)).toEqual({ convA: 'tA', convB: 'tB' })
  })

  it('surfaces a top-level error event even when the child exits 0', async () => {
    const binary = fakeCodex(
      '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"error","message":"not logged in"}\'\nexit 0\n',
    )
    const parts = await collect(new CodexCliModel(config(binary)))
    const errPart = parts.find((p) => p.type === 'error')
    expect(errPart?.type === 'error' ? String(errPart.error) : '').toContain('not logged in')
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({
      finishReason: { unified: 'error' },
    })
  })

  it('does not emit reasoning or command items as reply text', async () => {
    const binary = fakeCodex(
      `#!/usr/bin/env bash
cat >/dev/null
printf '%s\\n' '{"type":"item.updated","item":{"type":"agent_message","text":"hel"}}' '{"type":"item.completed","item":{"type":"reasoning","text":"I should run ls"}}' '{"type":"item.completed","item":{"type":"command_execution","text":"ls -la\\nfile.txt"}}' '{"type":"item.completed","item":{"type":"error","message":"ignored as text"}}' '{"type":"item.completed","item":{"type":"agent_message","text":"hello from Codex"}}' '{"type":"turn.completed","usage":{}}'
`,
    )
    const parts = await collect(new CodexCliModel(config(binary)))
    const deltas = parts.filter((p) => p.type === 'text-delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ delta: 'hello from Codex' })
    expect(parts.some((p) => p.type === 'error')).toBe(false)
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({
      finishReason: { unified: 'stop' },
    })
  })

  it('joins multiple agent_message items with a newline', async () => {
    const binary = fakeCodex(
      `#!/usr/bin/env bash
cat >/dev/null
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}' '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}' '{"type":"turn.completed","usage":{}}'
`,
    )
    const parts = await collect(new CodexCliModel(config(binary)))
    const deltas = parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p.type === 'text-delta' ? p.delta : ''))
    expect(deltas).toEqual(['first', '\n', 'second'])
  })

  it('does not persist a thread in replay mode', async () => {
    const binary = fakeCodex(HEALTHY)
    const map = join(mkdtempSync(join(tmpdir(), 'codex-replay-')), 'map.json')
    await collect(new CodexCliModel(config(binary, map, { sessionMode: 'replay' })))
    expect(loadSessionMap(map)).toEqual({})
  })

  it('passes per-turn reasoningEffort and omits -m for the default model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-opts-'))
    const binary = fakeCodex(
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "${CODEX_ARGS_FILE}"\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\' \'{"type":"turn.completed","usage":{}}\'\n',
    )
    const oldArgs = process.env.CODEX_ARGS_FILE
    process.env.CODEX_ARGS_FILE = join(dir, 'args')
    try {
      const model = new CodexCliModel(config(binary))
      const { stream } = await model.doStream({
        prompt,
        providerOptions: { 'codex-cli': { reasoningEffort: 'xhigh' } },
      })
      const reader = stream.getReader()
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
      const args = readFileSync(process.env.CODEX_ARGS_FILE, 'utf8')
      expect(args).toContain('model_reasoning_effort=xhigh')
      expect(args).not.toMatch(/(^|\n)-m(\n|$)/)
    } finally {
      if (oldArgs === undefined) delete process.env.CODEX_ARGS_FILE
      else process.env.CODEX_ARGS_FILE = oldArgs
    }
  })

  it('finishes abort with raw aborted and no error part', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-abort-'))
    const pidfile = join(dir, 'pid')
    const oldPid = process.env.CODEX_TEST_PIDFILE
    process.env.CODEX_TEST_PIDFILE = pidfile
    const binary = fakeCodex(
      '#!/usr/bin/env bash\necho $$ > "$CODEX_TEST_PIDFILE"\nexec sleep 30\n',
    )
    const ac = new AbortController()
    try {
      const { stream } = await new CodexCliModel(config(binary)).doStream({
        prompt,
        abortSignal: ac.signal,
      })
      const reader = stream.getReader()
      expect(await waitFor(() => existsSync(pidfile))).toBe(true)
      ac.abort()
      const parts: LanguageModelV3StreamPart[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
      expect(parts.some((p) => p.type === 'error')).toBe(false)
      expect(parts.find((p) => p.type === 'finish')).toMatchObject({
        finishReason: { unified: 'error', raw: 'aborted' },
      })
      const pid = Number(readFileSync(pidfile, 'utf8').trim())
      expect(await waitFor(() => !pidAlive(pid), 4000)).toBe(true)
    } finally {
      if (oldPid === undefined) delete process.env.CODEX_TEST_PIDFILE
      else process.env.CODEX_TEST_PIDFILE = oldPid
    }
  })

  it('isAvailable is false when the binary is missing and does not hang', async () => {
    const provider = new CodexCliProvider({ binary: join(tmpdir(), 'no-such-codex-cli-bin') })
    await expect(provider.isAvailable()).resolves.toBe(false)
  })
})
