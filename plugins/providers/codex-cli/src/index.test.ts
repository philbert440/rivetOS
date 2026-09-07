import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import {
  buildArgs,
  CodexCliModel,
  parseCodexLine,
  renderPrompt,
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
  }
}

async function collect(model: CodexCliModel): Promise<LanguageModelV3StreamPart[]> {
  const { stream } = await model.doStream({ prompt })
  const reader = stream.getReader()
  const out: LanguageModelV3StreamPart[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

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
  })

  it('streams agent messages, records the thread and reports usage', async () => {
    const binary = fakeCodex(
      '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"thread-1"}\' \'{"type":"item.completed","item":{"type":"agent_message","text":"hello from Codex"}}\' \'{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":2,"output_tokens":4,"reasoning_output_tokens":1}}\'\n',
    )
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

  it('resumes with only the newest user input', async () => {
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
      expect(
        await import('node:fs').then((fs) => fs.readFileSync(process.env.CODEX_ARGS_FILE!, 'utf8')),
      ).toContain('resume\nthread-old')
      expect(
        await import('node:fs').then((fs) =>
          fs.readFileSync(process.env.CODEX_PROMPT_FILE!, 'utf8'),
        ),
      ).toBe('again')
    } finally {
      if (oldArgs === undefined) delete process.env.CODEX_ARGS_FILE
      else process.env.CODEX_ARGS_FILE = oldArgs
      if (oldPrompt === undefined) delete process.env.CODEX_PROMPT_FILE
      else process.env.CODEX_PROMPT_FILE = oldPrompt
    }
  })
})
