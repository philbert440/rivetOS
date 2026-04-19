/**
 * Unit tests for synthesizeToolCallContent().
 *
 * Runs against a local HTTP stub — no live LLM, no DB required.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { synthesizeToolCallContent } from './tool-synth.ts'

interface StubRequest {
  body: unknown
  authHeader: string | undefined
}

interface StubResponse {
  status?: number
  jsonBody: unknown
  delayMs?: number
}

// A lightweight programmable LLM stub. Each test configures the next response.
class LlmStub {
  private server: Server | null = null
  private port = 0
  private nextResponses: StubResponse[] = []
  public calls: StubRequest[] = []

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf-8')
        })
        req.on('end', () => {
          let body: unknown = null
          try {
            body = raw.length > 0 ? JSON.parse(raw) : null
          } catch {
            body = raw
          }
          this.calls.push({ body, authHeader: req.headers.authorization })

          const next = this.nextResponses.shift() ?? { status: 500, jsonBody: { error: 'no stub' } }
          const status = next.status ?? 200
          const payload = JSON.stringify(next.jsonBody)

          const finish = (): void => {
            res.statusCode = status
            res.setHeader('content-type', 'application/json')
            res.end(payload)
          }

          if (next.delayMs) setTimeout(finish, next.delayMs)
          else finish()
        })
      })
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv
        const addr = srv.address() as AddressInfo
        this.port = addr.port
        resolve(`http://127.0.0.1:${addr.port}`)
      })
      srv.on('error', reject)
    })
  }

  enqueue(resp: StubResponse): void {
    this.nextResponses.push(resp)
  }

  reset(): void {
    this.nextResponses = []
    this.calls = []
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }
}

function makeChatResponse(content: string): StubResponse {
  return {
    status: 200,
    jsonBody: {
      choices: [{ message: { content } }],
    },
  }
}

describe('synthesizeToolCallContent', () => {
  const stub = new LlmStub()

  beforeAll(async () => {
    await stub.start()
  })

  afterAll(async () => {
    await stub.stop()
  })

  beforeEach(() => stub.reset())

  // ---------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------

  it('returns cleaned synthesized sentence for a tool call', async () => {
    stub.enqueue(makeChatResponse('Ran df -h to check disk usage.'))
    const result = await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'test-model',
      toolName: 'exec',
      toolArgs: { command: 'df -h' },
    })
    expect(result).toBe('Ran df -h to check disk usage.')
  })

  it('trims whitespace from response', async () => {
    stub.enqueue(makeChatResponse('   Edited config.yaml to fix port.   '))
    const result = await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'edit',
      toolArgs: {},
    })
    expect(result).toBe('Edited config.yaml to fix port.')
  })

  it('sends model, messages, and temperature in the request body', async () => {
    stub.enqueue(makeChatResponse('Checked gateway.'))
    await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'gemma-test',
      toolName: 'gateway',
      toolArgs: { path: 'agents.list' },
    })
    expect(stub.calls).toHaveLength(1)
    const body = stub.calls[0].body as {
      model: string
      messages: Array<{ role: string; content: string }>
      temperature: number
    }
    expect(body.model).toBe('gemma-test')
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].role).toBe('user')
    expect(body.temperature).toBe(0.2)
  })

  it('sends bearer auth header when apiKey provided', async () => {
    stub.enqueue(makeChatResponse('Searched logs.'))
    await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      apiKey: 'sk-secret',
      toolName: 'exec',
      toolArgs: {},
    })
    expect(stub.calls[0].authHeader).toBe('Bearer sk-secret')
  })

  it('omits auth header when no apiKey provided', async () => {
    stub.enqueue(makeChatResponse('Ran ls.'))
    await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'exec',
      toolArgs: {},
    })
    expect(stub.calls[0].authHeader).toBeUndefined()
  })

  it('includes toolResult and precedingContent in the user message when provided', async () => {
    stub.enqueue(makeChatResponse('Checked disk.'))
    await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'exec',
      toolArgs: { command: 'df -h' },
      toolResult: 'Filesystem 100G used 40G',
      precedingContent: 'Let me check disk usage.',
    })
    const body = stub.calls[0].body as { messages: Array<{ content: string }> }
    expect(body.messages[1].content).toContain('tool_name: exec')
    expect(body.messages[1].content).toContain('tool_result:')
    expect(body.messages[1].content).toContain('preceding_message:')
  })

  // ---------------------------------------------------------------------
  // Validation rejections
  // ---------------------------------------------------------------------

  it('rejects output starting with "The assistant"', async () => {
    stub.enqueue(makeChatResponse('The assistant ran df -h to check disk.'))
    const result = await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'exec',
      toolArgs: {},
    })
    expect(result).toBeNull()
  })

  it('rejects output that is too short', async () => {
    stub.enqueue(makeChatResponse('Ran.'))
    const result = await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'exec',
      toolArgs: {},
    })
    expect(result).toBeNull()
  })

  it('rejects output that is too long', async () => {
    stub.enqueue(makeChatResponse('x'.repeat(501) + '.'))
    const result = await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'exec',
      toolArgs: {},
    })
    expect(result).toBeNull()
  })

  it('rejects output that does not end with punctuation', async () => {
    stub.enqueue(makeChatResponse('Ran df -h to check disk usage'))
    const result = await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'exec',
      toolArgs: {},
    })
    expect(result).toBeNull()
  })

  it('returns null on empty content', async () => {
    stub.enqueue({
      status: 200,
      jsonBody: { choices: [{ message: { content: '' } }] },
    })
    const result = await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'exec',
      toolArgs: {},
    })
    expect(result).toBeNull()
  })

  // ---------------------------------------------------------------------
  // Retry / error handling
  // ---------------------------------------------------------------------

  it('retries on HTTP 5xx and eventually succeeds', async () => {
    stub.enqueue({ status: 500, jsonBody: { error: 'flake' } })
    stub.enqueue(makeChatResponse('Ran after retry.'))
    const result = await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'exec',
      toolArgs: {},
    })
    expect(result).toBe('Ran after retry.')
    expect(stub.calls.length).toBe(2)
  }, 15000)

  it('returns null on persistent non-retryable HTTP error (400)', async () => {
    stub.enqueue({ status: 400, jsonBody: { error: 'bad request' } })
    const result = await synthesizeToolCallContent({
      endpoint: stub.baseUrl,
      model: 'm',
      toolName: 'exec',
      toolArgs: {},
    })
    expect(result).toBeNull()
    expect(stub.calls.length).toBe(1)
  })
})
