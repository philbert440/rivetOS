/**
 * @rivetos/provider-kimi-code
 * Shells out to local Kimi Code CLI (`kimi -p --output-format stream-json`).
 * Implements aiSdkBridge so RivetOS AgentLoop can drive it via streamText.
 */
'use strict'

const { spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const DEFAULT_BINARY = process.env.KIMI_BINARY || join(homedir(), '.local/bin/kimi')
const SESSION_MAP = join(homedir(), '.rivetos', 'kimi-code-sessions.json')

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

class KimiCodeModel {
  constructor(config) {
    this.specificationVersion = 'v3'
    this.provider = 'kimi-code'
    this.modelId = config.modelId || 'moonshotai/kimi-k3'
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
    const prompt = promptFromOptions(options) || '(no instruction was provided for this turn)'
    const binary = this.config.binary
    const modelId = this.modelId
    const cwd = this.config.cwd
    const kimiHome = this.config.kimiHome
    const convKey = this.config.conversationId || 'default'
    const abortSignal = options.abortSignal
    const map = loadMap()
    const sessionId = map[convKey]

    const args = ['-p', prompt, '--output-format', 'stream-json']
    if (modelId) args.push('-m', modelId)
    if (sessionId) args.push('-S', sessionId)

    const childEnv = { ...process.env }
    if (kimiHome) childEnv.KIMI_CODE_HOME = kimiHome

    const stream = new ReadableStream({
      start(controller) {
        const TEXT_ID = 'kimi-text'
        let textOpen = false
        let sawText = false
        let stderr = ''

        controller.enqueue({ type: 'stream-start', warnings: [] })

        if (!existsSync(binary)) {
          controller.enqueue({ type: 'error', error: new Error(`kimi binary not found at ${binary}`) })
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
          env: childEnv,
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

        child.stderr.on('data', (c) => {
          stderr += c.toString()
          if (stderr.length > 64000) stderr = stderr.slice(-32000)
        })

        let buffer = ''
        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString()
          let nl
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line) continue
            let ev
            try { ev = JSON.parse(line) } catch { continue }
            if (ev.role === 'assistant' && typeof ev.content === 'string' && ev.content) {
              emitText(ev.content)
            } else if (ev.role === 'meta' && ev.type === 'session.resume_hint') {
              const sid = ev.session_id
              if (typeof sid === 'string' && sid && sid !== sessionId) {
                map[convKey] = sid
                saveMap(map)
              }
            }
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
                delta: `⚠️ kimi-code bridge error: ${(stderr || 'exit ' + code).slice(0, 500)}`,
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

class KimiCodeProvider {
  constructor(config = {}) {
    this.id = 'kimi-code'
    this.name = config.name || 'Kimi Code (CLI)'
    this._model = config.model || 'moonshotai/kimi-k3'
    this.binary = config.binary || DEFAULT_BINARY
    this.cwd = config.cwd || join(homedir(), '.rivetos', 'workspace')
    this.kimiHome = config.home || join(homedir(), '.kimi-code')
    this.contextWindow = Number(config.context_window) || 256000
    this.maxOutputTokens = Number(config.max_output_tokens) || 8192
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
        return new KimiCodeModel({
          providerId: self.id,
          modelId: modelOverride || self._model,
          binary: self.binary,
          cwd: self.cwd,
          kimiHome: self.kimiHome,
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
  name: 'kimi-code',
  register(ctx) {
    const cfg = ctx.pluginConfig ?? {}
    ctx.registerProvider(
      new KimiCodeProvider({
        name: cfg.name,
        model: cfg.model,
        binary: cfg.binary,
        cwd: cfg.cwd,
        home: cfg.home,
        context_window: cfg.context_window,
        max_output_tokens: cfg.max_output_tokens,
      }),
    )
  },
}

module.exports = { KimiCodeProvider, KimiCodeModel, manifest }
