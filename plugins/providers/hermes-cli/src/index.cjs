/**
 * @rivetos/provider-hermes-cli
 * Shells out to local Hermes Agent (`hermes chat -q`) — full agent tools inside the CLI.
 * Implements aiSdkBridge so RivetOS AgentLoop can drive it via streamText.
 */
'use strict'

const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const DEFAULT_BINARY = process.env.HERMES_BINARY || join(homedir(), '.local/bin/hermes')
const SESSION_MAP = join(homedir(), '.rivetos', 'hermes-cli-sessions.json')

function loadMap() {
  try {
    if (existsSync(SESSION_MAP)) return JSON.parse(readFileSync(SESSION_MAP, 'utf8'))
  } catch {}
  return {}
}
function saveMap(map) {
  try {
    mkdirSync(join(homedir(), '.rivetos'), { recursive: true })
    writeFileSync(SESSION_MAP, JSON.stringify(map, null, 2))
  } catch {}
}

function promptFromOptions(options) {
  const prompt = options?.prompt
  if (Array.isArray(prompt)) {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const m = prompt[i]
      if (m.role === 'user') {
        if (typeof m.content === 'string') return m.content
        if (Array.isArray(m.content)) {
          return m.content
            .map((p) => {
              if (typeof p === 'string') return p
              if (p && p.type === 'text' && typeof p.text === 'string') return p.text
              return ''
            })
            .filter(Boolean)
            .join('\n')
        }
      }
    }
  }
  return ''
}

class HermesCliModel {
  constructor(config) {
    this.specificationVersion = 'v3'
    this.provider = 'hermes-cli'
    this.modelId = config.modelId || 'qwen-27b'
    this.config = config
    this.supportedUrls = {}
  }

  async doGenerate(options) {
    const result = await this.doStream(options)
    let text = ''
    const reader = result.stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.type === 'text-delta' && value.delta) text += value.delta
    }
    return {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop' },
      usage: {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }
  }

  async doStream(options) {
    const prompt = promptFromOptions(options)
    const binary = this.config.binary
    const modelId = this.modelId
    const cwd = this.config.cwd
    const convKey = this.config.conversationId || 'default'
    const abortSignal = options.abortSignal
    const map = loadMap()
    const sessionId = map[convKey]

    const args = ['chat', '-q', prompt || '(empty)', '-Q', '--yolo', '--cli']
    if (modelId) args.push('-m', modelId)
    if (cwd) args.push('--in', cwd)
    if (sessionId) args.push('--resume', sessionId)

    const stream = new ReadableStream({
      start(controller) {
        const TEXT_ID = 'hermes-text'
        let textOpen = false
        let sawText = false
        let stderr = ''
        let stdout = ''

        controller.enqueue({ type: 'stream-start', warnings: [] })

        if (!existsSync(binary)) {
          controller.enqueue({ type: 'error', error: new Error(`hermes binary not found at ${binary}`) })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'error', raw: 'missing-binary' },
            usage: {
              inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
          })
          controller.close()
          return
        }

        const child = spawn(binary, args, {
          cwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        const kill = () => {
          try { child.kill('SIGTERM') } catch {}
        }
        if (abortSignal) {
          if (abortSignal.aborted) kill()
          else abortSignal.addEventListener('abort', kill, { once: true })
        }

        const emitText = (chunk) => {
          if (!chunk) return
          if (!textOpen) {
            controller.enqueue({ type: 'text-start', id: TEXT_ID })
            textOpen = true
          }
          sawText = true
          controller.enqueue({ type: 'text-delta', id: TEXT_ID, delta: chunk })
        }

        child.stdout.on('data', (c) => {
          const s = c.toString()
          stdout += s
          emitText(s)
        })

        child.stderr.on('data', (c) => {
          stderr += c.toString()
          if (stderr.length > 64000) stderr = stderr.slice(-32000)
          const m = stderr.match(/session_id:\s*(\S+)/)
          if (m && m[1] && m[1] !== sessionId) {
            map[convKey] = m[1]
            saveMap(map)
          }
        })

        child.on('error', (err) => {
          try { controller.enqueue({ type: 'error', error: err }) } catch {}
        })

        child.on('close', (code) => {
          try {
            if (abortSignal) abortSignal.removeEventListener('abort', kill)
            if (textOpen) controller.enqueue({ type: 'text-end', id: TEXT_ID })
            if (!sawText && code !== 0) {
              controller.enqueue({ type: 'text-start', id: TEXT_ID })
              controller.enqueue({
                type: 'text-delta',
                id: TEXT_ID,
                delta: `⚠️ hermes-cli bridge error: ${(stderr || 'exit ' + code).slice(0, 500)}`,
              })
              controller.enqueue({ type: 'text-end', id: TEXT_ID })
            }
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: code === 0 ? 'stop' : 'error', raw: String(code) },
              usage: {
                inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
              },
            })
            controller.close()
          } catch {
            try { controller.close() } catch {}
          }
        })
      },
    })

    return {
      stream,
      request: { body: JSON.stringify({ prompt, sessionId }) },
      response: { headers: undefined },
    }
  }
}

class HermesCliProvider {
  constructor(config = {}) {
    this.id = 'hermes-cli'
    this.name = config.name || 'Hermes Agent (CLI)'
    this._model = config.model || 'qwen-27b'
    this.binary = config.binary || DEFAULT_BINARY
    this.cwd = config.cwd || join(homedir(), '.rivetos', 'workspace')
    this.contextWindow = Number(config.context_window) || 262144
    this.maxOutputTokens = Number(config.max_output_tokens) || 81920
  }

  getModel() { return this._model }
  setModel(m) { this._model = m }
  getContextWindow() { return this.contextWindow }
  getMaxOutputTokens() { return this.maxOutputTokens }
  async isAvailable() { return existsSync(this.binary) }

  aiSdkBridge() {
    const self = this
    return {
      getModel({ modelOverride, conversationId } = {}) {
        return new HermesCliModel({
          providerId: self.id,
          modelId: modelOverride || self._model,
          binary: self.binary,
          cwd: self.cwd,
          conversationId,
        })
      },
      buildProviderOptions() {
        return undefined
      },
    }
  }
}

const manifest = {
  type: 'provider',
  name: 'hermes-cli',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new HermesCliProvider({
        name: cfg.name,
        model: cfg.model,
        binary: cfg.binary,
        cwd: cfg.cwd,
        context_window: cfg.context_window,
        max_output_tokens: cfg.max_output_tokens,
      }),
    )
  },
}

module.exports = { HermesCliProvider, HermesCliModel, manifest }
