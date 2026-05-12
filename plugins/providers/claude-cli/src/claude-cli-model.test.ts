/**
 * Unit tests for renderPromptForCli — the AI SDK prompt → CLI stream-json
 * content-block translator. Focused on the image-support behavior added on
 * top of the original text-only renderer.
 */

import { describe, expect, it } from 'vitest'
import type { LanguageModelV3Prompt } from '@ai-sdk/provider'

import { renderPromptForCli } from './claude-cli-model.js'

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
