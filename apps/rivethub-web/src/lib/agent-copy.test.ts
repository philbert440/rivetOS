import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import {
  agentCopySeed,
  canOfferAgentCopy,
  copyFormDirectory,
  type AgentDraft,
  type CopyTarget,
} from './agent-copy.js'

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
    for (const nodeBaseUrl of ['', 'https://owner.example']) {
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
    // A preset URL is not placement. It does not block the copy and is not seeded.
    const seeded = agentCopySeed(
      draft,
      { ...source, sourceNodeBaseUrl: 'https://owner.example' },
      { ...target, nodeBaseUrl: source.nodeBaseUrl },
    )
    assert.equal(Object.hasOwn(seeded.seed, 'nodeBaseUrl'), false)
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

describe('agentCopySeed directory', () => {
  it('carries directory and sharedLink onto the create seed', () => {
    const result = agentCopySeed(
      { ...draft, directory: '~/agents/reviewer', sharedLink: false },
      source,
      target,
    )
    assert.equal(result.seed.directory, '~/agents/reviewer')
    assert.equal(result.seed.sharedLink, false)
  })

  it('drops directory when it is the source default root/slug', () => {
    const result = agentCopySeed(
      { ...draft, name: 'Reviewer (copy)', directory: '/srv/agents/reviewer/' },
      { ...source, name: 'Reviewer', directoryRoot: '/srv/agents/' },
      target,
    )
    assert.equal(result.seed.directory, undefined)
    assert.equal(Object.hasOwn(result.seed, 'directory'), false)
  })

  it('keeps a directory that is not the source default', () => {
    const result = agentCopySeed(
      { ...draft, directory: '/srv/agents/custom' },
      { ...source, name: 'Reviewer', directoryRoot: '/srv/agents' },
      target,
    )
    assert.equal(result.seed.directory, '/srv/agents/custom')
  })
})

describe('copy form directory', () => {
  it('submits the cleaned seed, not the source default the seed dropped', () => {
    const seeded = agentCopySeed(
      { ...draft, name: 'Reviewer (copy)', directory: '/srv/agents/reviewer/' },
      { ...source, name: 'Reviewer', directoryRoot: '/srv/agents/' },
      target,
    )
    assert.equal(seeded.seed.directory, undefined)
    assert.equal(copyFormDirectory('/srv/agents/reviewer/', seeded.seed), '')
  })

  it('submits a directory the seed kept', () => {
    const seeded = agentCopySeed(
      { ...draft, directory: '/srv/agents/custom' },
      { ...source, name: 'Reviewer', directoryRoot: '/srv/agents' },
      target,
    )
    assert.equal(copyFormDirectory('/srv/agents/custom', seeded.seed), '/srv/agents/custom')
  })

  it('shows the draft directory until a seed exists', () => {
    assert.equal(copyFormDirectory('/srv/agents/reviewer', undefined), '/srv/agents/reviewer')
    assert.equal(copyFormDirectory(undefined, undefined), '')
  })

  it('keeps a custom path, clears a source default, and re-cleans an edit', () => {
    const rooted = { ...source, name: 'Reviewer', directoryRoot: '/srv/agents' }
    // The editor recomputes the seed from the current draft on every render,
    // then shows that cleaned directory. An edit is a new draft, not a patch
    // of the previous seed.
    const show = (directory: string): string => {
      const seeded = agentCopySeed({ ...draft, directory }, rooted, target)
      return copyFormDirectory(directory, seeded.seed)
    }
    assert.equal(show('/srv/agents/custom'), '/srv/agents/custom')
    assert.equal(show('/srv/agents/reviewer'), '')
    assert.equal(show('/srv/agents/elsewhere'), '/srv/agents/elsewhere')
    assert.equal(show('/srv/agents/reviewer/'), '')
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
