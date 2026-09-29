/**
 * Unit tests for renderPromptForCli — the AI SDK prompt → CLI stream-json
 * content-block translator. Focused on the image-support behavior added on
 * top of the original text-only renderer.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { APICallError, type LanguageModelV3, type LanguageModelV3Prompt } from '@ai-sdk/provider'
import type { Provider } from '@rivetos/types'

import { renderPromptForCli } from './claude-cli-model.js'
import { ClaudeCliProvider, manifest } from './index.js'

describe('renderPromptForCli', () => {
  it('text-only user turn yields one text block', () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    const { systemText, userContent } = renderPromptForCli(prompt)
    expect(systemText).toBe('be terse')
    expect(userContent).toEqual([{ type: 'text', text: 'USER:\nhello' }])
  })

  it('base64 string image becomes a base64 image block', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'file', mediaType: 'image/png', data: 'AAAA' },
        ],
      },
    ]
    const { userContent } = renderPromptForCli(prompt)
    expect(userContent).toEqual([
      { type: 'text', text: 'USER:\nwhat is this' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
    ])
  })

  it('Uint8Array image data is base64-encoded', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'caption' },
          { type: 'file', mediaType: 'image/jpeg', data: bytes },
        ],
      },
    ]
    const { userContent } = renderPromptForCli(prompt)
    expect(userContent[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: Buffer.from(bytes).toString('base64'),
      },
    })
  })

  it('URL image data becomes a url image block', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [
          { type: 'file', mediaType: 'image/webp', data: new URL('https://example.com/x.webp') },
        ],
      },
    ]
    const { userContent } = renderPromptForCli(prompt)
    expect(userContent).toEqual([
      { type: 'text', text: 'USER:' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/x.webp' } },
    ])
  })

  it('non-image file part degrades to a [file: <type>] text placeholder', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'attached pdf' },
          { type: 'file', mediaType: 'application/pdf', data: 'AAAA' },
        ],
      },
    ]
    const { userContent } = renderPromptForCli(prompt)
    expect(userContent).toEqual([
      { type: 'text', text: 'USER:\nattached pdf\n[file: application/pdf]' },
    ])
  })

  it('mixed history: assistant + tool result + new user turn with image', () => {
    const prompt: LanguageModelV3Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure' },
          {
            type: 'tool-call',
            toolCallId: 't1',
            toolName: 'echo',
            input: { msg: 'hi' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'echo',
            output: { type: 'text', value: 'hi' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'now look at this' },
          { type: 'file', mediaType: 'image/png', data: 'IMG' },
        ],
      },
    ]
    const { userContent } = renderPromptForCli(prompt)
    // Expected: text block carrying the full history up to the image,
    // then the image block (no trailing text since image is the last part).
    expect(userContent).toHaveLength(2)
    expect(userContent[0]).toEqual({
      type: 'text',
      text:
        'USER:\nfirst' +
        '\n\n---\n\nASSISTANT:\nsure' +
        '\n\n---\n\nASSISTANT TOOL CALLS:\n  - echo({"msg":"hi"})' +
        '\n\n---\n\nTOOL RESULT (t1):\nhi' +
        '\n\n---\n\nUSER:\nnow look at this',
    })
    expect(userContent[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'IMG' },
    })
  })

  it('image-only user turn still emits a USER: header', () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image/png', data: 'AAAA' }],
      },
    ]
    const { userContent } = renderPromptForCli(prompt)
    expect(userContent).toEqual([
      { type: 'text', text: 'USER:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
  })

  it('empty prompt yields no content blocks', () => {
    const { systemText, userContent } = renderPromptForCli([])
    expect(systemText).toBe('')
    expect(userContent).toEqual([])
  })
})

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

/** Fake claude that emits one system-init and a successful result. */
function fakeClaude(apiKeySource: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-model-'))
  tmpDirs.push(dir)
  const lines = [
    {
      type: 'system',
      subtype: 'init',
      session_id: 'fake-session',
      model: 'fake',
      apiKeySource,
      tools: [],
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'chat ok',
      session_id: 'fake-session',
    },
  ]
  fs.writeFileSync(path.join(dir, 'stdout.txt'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const binary = path.join(dir, 'claude')
  fs.writeFileSync(
    binary,
    [
      '#!/usr/bin/env bash',
      'cat > /dev/null',
      `cat "${dir}/stdout.txt"`,
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  )
  return binary
}

const PROMPT: LanguageModelV3Prompt = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

async function readTurn(model: LanguageModelV3): Promise<{ text: string; error?: unknown }> {
  const { stream } = await model.doStream({ prompt: PROMPT })
  const reader = stream.getReader()
  let text = ''
  let error: unknown
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') text += value.delta
      else if (value.type === 'error') error = value.error
    }
  } catch (err) {
    error ??= err
  }
  return { text, error }
}

describe('claude-cli apiKeySource gate', () => {
  it('rejects a non-none source on the chat model when no allow-list is set', async () => {
    const provider = new ClaudeCliProvider({ binary: fakeClaude('apiKeyHelper') })
    const { error } = await readTurn(provider.aiSdkBridge().getModel({}))
    expect(error).toBeInstanceOf(APICallError)
    const api = error as APICallError
    expect(api.statusCode).toBe(401)
    expect(api.isRetryable).toBe(false)
    expect(api.message).toContain('unexpected apiKeySource="apiKeyHelper"')
    expect(api.message).toContain('OAuth/keychain auth')
  })

  it('accepts a listed source from providers.claude-cli.allowed_api_key_sources', async () => {
    let registered: Provider | undefined
    manifest.register({
      pluginConfig: {
        binary: fakeClaude('apiKeyHelper'),
        allowed_api_key_sources: ['apiKeyHelper'],
      },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as Parameters<typeof manifest.register>[0])
    const provider = registered as ClaudeCliProvider
    const { text, error } = await readTurn(provider.aiSdkBridge().getModel({}))
    expect(error).toBeUndefined()
    expect(text).toBe('chat ok')
  })

  it('still rejects an unlisted source when another source is allowed', async () => {
    const provider = new ClaudeCliProvider({
      binary: fakeClaude('other'),
      allowedApiKeySources: ['apiKeyHelper'],
    })
    const { error } = await readTurn(provider.aiSdkBridge().getModel({}))
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).message).toContain('unexpected apiKeySource="other"')
  })

  it('fails closed when allowed_api_key_sources is not an array', async () => {
    let registered: Provider | undefined
    manifest.register({
      pluginConfig: {
        binary: fakeClaude('apiKeyHelper'),
        allowed_api_key_sources: 'apiKeyHelper',
      },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as Parameters<typeof manifest.register>[0])
    const provider = registered as ClaudeCliProvider
    const { error } = await readTurn(provider.aiSdkBridge().getModel({}))
    expect(error).toBeInstanceOf(APICallError)
    expect((error as APICallError).message).toContain('unexpected apiKeySource="apiKeyHelper"')
  })
})
