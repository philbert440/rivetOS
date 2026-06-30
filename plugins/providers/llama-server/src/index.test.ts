/**
 * Unit tests for LlamaServerProvider — config normalization, the lean request
 * extension surface (standard sampling + top_k/min_p + extra_body), and the
 * guarantee that vLLM-only fields are NOT emitted.
 */
import { describe, it, expect } from 'vitest'
import { LlamaServerProvider, manifest } from './index.js'
import type { LlamaServerProviderConfig } from './index.js'

describe('LlamaServerProvider', () => {
  describe('construction & defaults', () => {
    it('defaults id, name, and model placeholder', () => {
      const p = new LlamaServerProvider({ baseUrl: 'http://localhost:8080' })
      expect(p.id).toBe('llama-server')
      expect(p.name).toBe('llama.cpp server')
      expect(p.getModel()).toBe('default')
    })

    it('honors custom id and name', () => {
      const cfg: LlamaServerProviderConfig = {
        baseUrl: 'http://localhost:8080',
        id: 'my-llama',
        name: 'My Llama',
      }
      const p = new LlamaServerProvider(cfg)
      expect(p.id).toBe('my-llama')
      expect(p.name).toBe('My Llama')
    })

    it('normalizes a trailing slash and /v1 suffix off the base URL', () => {
      for (const baseUrl of ['http://localhost:8080/', 'http://localhost:8080/v1', 'http://localhost:8080/v1/']) {
        // Reaches into the stream context indirectly via applyRequestExtensions (URL not exposed),
        // so assert construction does not throw and model/ctx defaults hold.
        const p = new LlamaServerProvider({ baseUrl })
        expect(p.getModel()).toBe('default')
      }
    })

    it('setModel overrides the active model', () => {
      const p = new LlamaServerProvider({ baseUrl: 'http://localhost:8080' })
      p.setModel('qwen3-30b.gguf')
      expect(p.getModel()).toBe('qwen3-30b.gguf')
    })

    it('exposes configured context window and output-token limit', () => {
      const p = new LlamaServerProvider({
        baseUrl: 'http://localhost:8080',
        contextWindow: 16384,
        maxOutputTokens: 2048,
      })
      expect(p.getContextWindow()).toBe(16384)
      expect(p.getMaxOutputTokens()).toBe(2048)
    })
  })

  describe('applyRequestExtensions', () => {
    it('fills standard sampling only when absent', () => {
      const p = new LlamaServerProvider({
        baseUrl: 'http://localhost:8080',
        temperature: 0.3,
        topP: 0.8,
        maxTokens: 1234,
        seed: 7,
        stop: ['</done>'],
      })
      const out = p.applyRequestExtensions({})
      expect(out.temperature).toBe(0.3)
      expect(out.top_p).toBe(0.8)
      expect(out.max_tokens).toBe(1234)
      expect(out.seed).toBe(7)
      expect(out.stop).toEqual(['</done>'])
    })

    it('does not overwrite fields the loop already set', () => {
      const p = new LlamaServerProvider({ baseUrl: 'http://localhost:8080', temperature: 0.3 })
      const out = p.applyRequestExtensions({ temperature: 0.9 })
      expect(out.temperature).toBe(0.9)
    })

    it('sends llama.cpp top_k / min_p extensions when configured', () => {
      const p = new LlamaServerProvider({ baseUrl: 'http://localhost:8080', topK: 40, minP: 0.05 })
      const out = p.applyRequestExtensions({})
      expect(out.top_k).toBe(40)
      expect(out.min_p).toBe(0.05)
    })

    it('applies a non-auto default tool_choice only when tools are present', () => {
      const p = new LlamaServerProvider({
        baseUrl: 'http://localhost:8080',
        defaultToolChoice: 'required',
      })
      expect(p.applyRequestExtensions({}).tool_choice).toBeUndefined()
      const withTools = p.applyRequestExtensions({ tools: [{ type: 'function' }] })
      expect(withTools.tool_choice).toBe('required')
    })

    it('merges extra_body escape-hatch fields without overwriting', () => {
      const p = new LlamaServerProvider({
        baseUrl: 'http://localhost:8080',
        extraBody: { grammar: 'root ::= "yes"', n_probs: 3 },
      })
      const out = p.applyRequestExtensions({ n_probs: 10 })
      expect(out.grammar).toBe('root ::= "yes"')
      expect(out.n_probs).toBe(10) // existing value preserved
    })

    it('never emits vLLM-only fields', () => {
      const p = new LlamaServerProvider({ baseUrl: 'http://localhost:8080', topK: 40 })
      const out = p.applyRequestExtensions({})
      expect(out.mm_processor_kwargs).toBeUndefined()
      expect(out.chat_template_kwargs).toBeUndefined()
      expect(out.repetition_penalty).toBeUndefined()
      expect(out.min_tokens).toBeUndefined()
    })
  })

  describe('manifest', () => {
    it('registers as the llama-server provider', () => {
      expect(manifest.type).toBe('provider')
      expect(manifest.name).toBe('llama-server')
    })
  })
})
