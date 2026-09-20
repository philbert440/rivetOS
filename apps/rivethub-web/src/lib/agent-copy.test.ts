import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { agentCopySeed, canOfferAgentCopy, type AgentDraft, type CopyTarget } from './agent-copy.js'

const source = {
  id: 'old-id',
  createdAt: 100,
  updatedAt: 200,
  name: 'Stored name',
  color: '#000000',
  systemPrompt: 'Stored prompt',
  harnessId: 'codex',
  model: 'old-model',
  effort: 'old-effort',
  nodeBaseUrl: 'https://source.example',
  sourceNodeBaseUrl: 'https://source.example',
}
const draft: AgentDraft = {
  name: 'Unsaved name',
  color: '#123456',
  systemPrompt: 'Unsaved prompt',
  harnessId: 'codex',
  model: 'target-model',
  effort: 'high',
}
const target: CopyTarget = {
  nodeBaseUrl: 'https://target.example',
  harnesses: [
    {
      harnessId: 'codex',
      capabilities: {
        models: [
          { id: 'first', label: 'First' },
          {
            id: 'target-model',
            label: 'Target',
            default: true,
            efforts: [
              { id: 'low', label: 'Low', default: true },
              { id: 'high', label: 'High' },
            ],
          },
        ],
        efforts: [{ id: 'global', label: 'Global' }],
      },
    },
  ],
}

describe('agentCopySeed', () => {
  it('uses the current draft, the target URL, and only create fields', () => {
    const before = JSON.stringify({ draft, source, target })
    assert.deepEqual(agentCopySeed(draft, source, target), {
      seed: {
        name: 'Unsaved name (copy)',
        color: '#123456',
        systemPrompt: 'Unsaved prompt',
        harnessId: 'codex',
        model: 'target-model',
        effort: 'high',
        nodeBaseUrl: 'https://target.example',
      },
      notes: [],
    })
    assert.equal(JSON.stringify({ draft, source, target }), before)
  })

  it('adds the copy suffix exactly once, including repeated duplication', () => {
    for (const name of ['Agent', 'Agent (copy)', 'Agent (copy) (copy)']) {
      assert.equal(agentCopySeed({ ...draft, name }, source, target).seed.name, 'Agent (copy)')
    }
  })

  it('never accepts the source node or an empty target', () => {
    for (const nodeBaseUrl of ['', source.nodeBaseUrl, 'https://owner.example']) {
      assert.throws(() =>
        agentCopySeed(
          draft,
          { ...source, sourceNodeBaseUrl: 'https://owner.example' },
          {
            ...target,
            nodeBaseUrl,
          },
        ),
      )
    }
  })

  it('replaces an unsupported harness and its settings with target defaults, with notes', () => {
    const result = agentCopySeed(
      { ...draft, harnessId: 'claude-code', model: 'foreign', effort: 'max' },
      source,
      target,
    )
    assert.equal(result.seed.harnessId, 'codex')
    assert.equal(result.seed.model, 'target-model')
    assert.equal(result.seed.effort, 'low')
    for (const label of ['Harness', 'Model', 'Effort']) {
      assert.ok(result.notes.some((note) => note.startsWith(label)))
    }
  })

  it('replaces an unsupported model with the marked default and explains it', () => {
    const result = agentCopySeed({ ...draft, model: 'foreign' }, source, target)
    assert.equal(result.seed.model, 'target-model')
    assert.ok(result.notes.some((note) => note.startsWith('Model')))
  })

  it('uses model-specific efforts, rejecting even a harness-wide effort', () => {
    const result = agentCopySeed({ ...draft, effort: 'global' }, source, target)
    assert.equal(result.seed.effort, 'low')
    assert.ok(result.notes.some((note) => note.startsWith('Effort')))
  })

  it('clears unsupported settings when the target has no options', () => {
    const result = agentCopySeed(draft, source, { ...target, harnesses: [] })
    assert.equal(result.seed.harnessId, undefined)
    assert.equal(result.seed.model, '')
    assert.equal(result.seed.effort, '')
    assert.equal(result.notes.length, 3)
  })

  it('clears model and effort when a supported harness has no capability lists', () => {
    const result = agentCopySeed(draft, source, {
      ...target,
      harnesses: [{ harnessId: 'codex', capabilities: {} }],
    })
    assert.equal(result.seed.harnessId, 'codex')
    assert.equal(result.seed.model, '')
    assert.equal(result.seed.effort, '')
    assert.equal(result.notes.length, 2)
  })
})

describe('canOfferAgentCopy', () => {
  it('offers copying only for a failed request to the existing preset owner', () => {
    assert.equal(canOfferAgentCopy(source, source.sourceNodeBaseUrl, true), true)
    assert.equal(canOfferAgentCopy(undefined, source.sourceNodeBaseUrl, true), false)
    assert.equal(canOfferAgentCopy(source, target.nodeBaseUrl, true), false)
    assert.equal(canOfferAgentCopy(source, source.sourceNodeBaseUrl, false), false)
  })
})
