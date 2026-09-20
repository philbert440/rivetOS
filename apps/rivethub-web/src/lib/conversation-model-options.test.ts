import { describe, expect, it } from 'vitest'
import {
  conversationModelOptions as resolveOptions,
  conversationProtocolOwnership,
  spawnModelOptions,
  type ConversationTurnPick,
} from './conversation-model-options.js'
import { spawnModelEffort } from './harness-options.js'
import { mergeChatSettings, type ChatSettings } from '../stores/chat-settings.js'

// Existing cases describe protocol-owned conversations.
const conversationModelOptions = (
  harnessId: Parameters<typeof resolveOptions>[0],
  rows: Parameters<typeof resolveOptions>[1],
  pick: Parameters<typeof resolveOptions>[2],
  owned: boolean | undefined = true,
  currentModel?: string,
) => resolveOptions(harnessId, rows, pick, owned, currentModel)

const registry = [
  { harnessId: 'claude-code' as const, capabilities: { models: [{ id: 'opus', label: 'Opus' }] } },
  {
    harnessId: 'codex' as const,
    capabilities: {
      turnOptions: true,
      models: [
        { id: 'a', label: 'Model A', default: true, efforts: [{ id: 'high', label: 'High' }] },
        { id: 'b', label: 'Model B' },
      ],
    },
  },
]
const pick: ConversationTurnPick = { harnessId: 'codex', model: 'a', effort: 'high' }

describe('conversationModelOptions', () => {
  it('lists per-turn models and supplies the effective turn payload', () => {
    const result = conversationModelOptions('codex', registry, pick)
    expect(result.models).toEqual([
      { value: 'a', label: 'Model A' },
      { value: 'b', label: 'Model B' },
    ])
    expect({ text: 'hello', ...result.effective }).toEqual({
      text: 'hello',
      model: 'a',
      effort: 'high',
    })
    expect(result.clearPick).toBe(false)
  })
  it('has no picker or overrides without a sheet, turn options, or models', () => {
    for (const rows of [
      undefined,
      [],
      registry,
      [{ harnessId: 'claude-code' as const, capabilities: { turnOptions: true, models: [] } }],
    ]) {
      const result = conversationModelOptions('claude-code', rows, pick)
      expect(result.models).toEqual([])
      expect(result.effective).toEqual({})
    }
  })
  it('uses the sidebar session harness without preset settings or an agent catalog', () => {
    expect(
      conversationModelOptions('codex', registry, undefined).models.map((m) => m.value),
    ).toEqual(['a', 'b'])
    expect(conversationModelOptions(undefined, registry, undefined).models).toEqual([])
    expect(conversationModelOptions('claude-code', registry, undefined).models).toEqual([])
  })
  it('ignores and clears stale models and picks from a different harness', () => {
    for (const stale of [
      { ...pick, model: 'removed' },
      { ...pick, harnessId: 'claude-code' as const },
    ]) {
      const result = conversationModelOptions('codex', registry, stale)
      expect(result.effective).toEqual({})
      expect(result.clearPick).toBe(true)
    }
    expect(conversationModelOptions('codex', undefined, pick).clearPick).toBe(false)
    expect(conversationModelOptions(undefined, registry, pick).clearPick).toBe(false)
    expect(conversationModelOptions('codex', [], pick).clearPick).toBe(true)
  })
  it('supports harness defaults and rejects unsupported effort', () => {
    expect(conversationModelOptions('codex', registry, { harnessId: 'codex' }).effective).toEqual(
      {},
    )
    const result = conversationModelOptions('codex', registry, { ...pick, effort: 'removed' })
    expect(result.effective).toEqual({ model: 'a' })
    expect(result.clearPick).toBe(true)
  })
})

describe('per-conversation settings', () => {
  const launch: ChatSettings = {
    agent: 'codex',
    harnessId: 'codex',
    effort: 'medium',
    model: 'launch-model',
    harnessEffort: 'low',
  }
  it('model picks leave launch command selection and spawn flags unchanged', () => {
    const next = mergeChatSettings(launch, { turnPick: pick })
    expect(next.agent).toBe(launch.agent)
    expect(next.harnessId).toBe(launch.harnessId)
    expect(spawnModelEffort(next)).toEqual(spawnModelEffort(launch))
    expect(conversationModelOptions('codex', registry, next.turnPick).effective.model).toBe('a')
  })
  it('preserves overrides when a conversation is rekeyed to a new settings key', () => {
    expect(mergeChatSettings(undefined, { ...launch, turnPick: pick }).turnPick).toEqual(pick)
  })
  it('agent or harness changes clear both turn overrides', () => {
    const current = { ...launch, turnPick: pick }
    expect(mergeChatSettings(current, { agent: 'grok' }).turnPick).toBeUndefined()
    expect(mergeChatSettings(current, { harnessId: 'grok-build' }).turnPick).toBeUndefined()
    expect(mergeChatSettings(current, { agent: 'codex' }).turnPick).toEqual(pick)
    expect(mergeChatSettings(current, { effort: 'high' }).turnPick).toEqual(pick)
  })
  it('a harness/agent change drops a stale spawn model, but a co-set model wins (#814)', () => {
    // Switch harness alone → the previous harness's --model is dropped.
    expect(mergeChatSettings(launch, { harnessId: 'grok-build' }).model).toBeUndefined()
    expect(mergeChatSettings(launch, { agent: 'grok' }).model).toBeUndefined()
    // A patch that stamps harnessId + model together (opening a preset) keeps the new model.
    expect(mergeChatSettings(launch, { harnessId: 'claude-code', model: 'opus' }).model).toBe('opus')
    // An unrelated change leaves the model in place.
    expect(mergeChatSettings(launch, { effort: 'high' }).model).toBe('launch-model')
  })
})

describe('per-turn ownership gate', () => {
  it('offers options and attaches a pick only after protocol ownership is established', () => {
    const unowned = conversationModelOptions('codex', registry, pick, false)
    expect(unowned.models).toEqual([])
    const owned = conversationModelOptions('codex', registry, pick, true)
    expect(owned.models.map((row) => row.value)).toEqual(['a', 'b'])
    expect({ text: 'hello', ...owned.effective }).toEqual({
      text: 'hello',
      model: 'a',
      effort: 'high',
    })
  })
  it('offers no picker and attaches nothing for a PTY row with the same sheet', () => {
    const result = conversationModelOptions('codex', registry, pick, false)
    expect(result.models).toEqual([])
    expect(result.efforts).toEqual([])
    expect({ text: 'hello', ...result.effective }).toEqual({ text: 'hello' })
  })
  it('offers options when a draft is adopted by the protocol', () => {
    expect(conversationModelOptions('codex', registry, undefined, false).models).toEqual([])
    expect(conversationModelOptions('codex', registry, undefined, true).models).toHaveLength(2)
  })
  it('ignores and clears a persisted pick when ownership is lost', () => {
    expect(conversationModelOptions('codex', registry, pick, true).effective).toEqual({
      model: 'a',
      effort: 'high',
    })
    const result = conversationModelOptions('codex', registry, pick, false)
    expect(result.effective).toEqual({})
    expect(result.clearPick).toBe(true)
    expect(result.retainedPick).toBeUndefined()
  })
})

describe('model and effort validation', () => {
  it('uses the session model for default effort choices without overriding its model', () => {
    const result = conversationModelOptions(
      'codex',
      registry,
      { harnessId: 'codex', effort: 'high' },
      true,
      'b',
    )
    expect(result.efforts).toEqual([])
    expect(result.effective).toEqual({})
    expect(result.defaultModelLabel).toBe('Session default (Model B)')
    expect(result.clearPick).toBe(true)
  })
  it('preserves the valid model when clearing stale effort', () => {
    const result = conversationModelOptions('codex', registry, { ...pick, effort: 'removed' })
    expect(result.clearPick).toBe(true)
    expect(result.retainedPick).toEqual({ harnessId: 'codex', model: 'a' })
    const next = conversationModelOptions('codex', registry, result.retainedPick)
    expect(next.effective).toEqual({ model: 'a' })
    expect(next.clearPick).toBe(false)
  })
  it('keeps a supported effort across model changes and removes an unsupported one', () => {
    const rows = [
      {
        harnessId: 'codex' as const,
        capabilities: {
          turnOptions: true,
          models: [
            { id: 'a', label: 'A', efforts: [{ id: 'high', label: 'High' }] },
            { id: 'b', label: 'B', efforts: [{ id: 'high', label: 'High' }] },
            { id: 'c', label: 'C', efforts: [{ id: 'low', label: 'Low' }] },
          ],
        },
      },
    ]
    const previous = conversationModelOptions('codex', rows, pick)
    const changed = { harnessId: 'codex' as const, ...previous.effective, model: 'b' }
    expect(conversationModelOptions('codex', rows, changed).effective).toEqual({
      model: 'b',
      effort: 'high',
    })
    expect(
      conversationModelOptions('codex', rows, { ...changed, model: 'c' }).retainedPick,
    ).toEqual({ harnessId: 'codex', model: 'c' })
  })
  it('does not erase a persisted pick while ownership is unknown', () => {
    const result = resolveOptions('codex', registry, pick, undefined)
    expect(result.models).toEqual([])
    expect(result.effective).toEqual({})
    expect(result.clearPick).toBe(false)
  })
  it('does not borrow default-model efforts for an unknown session model', () => {
    expect(
      conversationModelOptions('codex', registry, undefined, true, 'unlisted').efforts,
    ).toEqual([])
  })
})

describe('ownership query lifecycle', () => {
  // A loaded protocol summary can precede the registry on a remote cold load.
  const resolve = (registryReady: boolean, bound = false, summaryReady = true, cached = false) =>
    resolveOptions(
      'codex',
      registryReady || cached ? registry : undefined,
      pick,
      conversationProtocolOwnership({ registryReady, summaryReady, bound, transport: 'protocol' }),
    )
  const persist = (result: ReturnType<typeof resolveOptions>, stored = pick) =>
    result.clearPick
      ? mergeChatSettings(
          { agent: 'codex', effort: 'medium', turnPick: stored },
          {
            turnPick: result.retainedPick,
          },
        ).turnPick
      : stored

  it('preserves a saved pick with the summary loaded and registry pending; sends plain text', () => {
    const result = resolve(false)
    expect(result.models).toEqual([])
    expect(result.efforts).toEqual([])
    expect(result.clearPick).toBe(false)
    expect(persist(result)).toEqual(pick)
    expect({ text: 'hello', ...result.effective }).toEqual({ text: 'hello' })
  })
  it('offers and applies the same saved pick when the registry settles owned', () => {
    const stored = persist(resolve(false))
    expect(stored).toEqual(pick)
    const settled = resolve(true, true)
    expect(settled.models).toHaveLength(2)
    expect(settled.effective).toEqual({ model: 'a', effort: 'high' })
    expect(persist(settled, stored)).toEqual(pick)
  })
  it('clears only after the registry settles not owned', () => {
    expect(persist(resolve(false))).toEqual(pick)
    const settled = resolve(true)
    expect(settled.clearPick).toBe(true)
    expect(persist(settled)).toBeUndefined()
  })
  it('does not clear on registry error, even with cached descriptor data', () => {
    const result = resolve(false, true, true, true)
    expect(result.clearPick).toBe(false)
    expect(result.models).toEqual([])
    expect(result.effective).toEqual({})
    expect(persist(result)).toEqual(pick)
  })
  it('keeps ownership unknown while the summary is pending or errored', () => {
    const result = resolve(true, true, false)
    expect(result.clearPick).toBe(false)
    expect(result.effective).toEqual({})
    expect(persist(result)).toEqual(pick)
  })
  it('still clears immediately on agent or harness changes while queries are unresolved', () => {
    const current: ChatSettings = {
      agent: 'codex',
      effort: 'medium',
      harnessId: 'codex',
      turnPick: persist(resolve(false)),
    }
    expect(current.turnPick).toEqual(pick)
    expect(mergeChatSettings(current, { agent: 'grok' }).turnPick).toBeUndefined()
    expect(mergeChatSettings(current, { harnessId: 'grok-build' }).turnPick).toBeUndefined()
  })
})

describe('spawnModelOptions (#814)', () => {
  const spawnRegistry = [
    {
      harnessId: 'claude-code' as const,
      capabilities: {
        launchModel: true,
        models: [
          { id: 'fable', label: 'Fable 5.1', default: true },
          { id: 'opus', label: 'Opus 5' },
          { id: 'sonnet', label: 'Sonnet 5' },
        ],
      },
    },
    // A turn-switching harness with models but NOT launchModel: no spawn picker.
    {
      harnessId: 'codex' as const,
      capabilities: { turnOptions: true, models: [{ id: 'a', label: 'Model A' }] },
    },
  ]

  it('lists the harness sheet before bind, with the default labelled', () => {
    const r = spawnModelOptions('claude-code', spawnRegistry, undefined, false)
    expect(r.models).toEqual([
      { value: 'fable', label: 'Fable 5.1' },
      { value: 'opus', label: 'Opus 5' },
      { value: 'sonnet', label: 'Sonnet 5' },
    ])
    expect(r.value).toBe('')
    expect(r.defaultModelLabel).toBe('Harness default (Fable 5.1)')
    // A stored on-sheet model is reflected as the selected value.
    expect(spawnModelOptions('claude-code', spawnRegistry, 'opus', false).value).toBe('opus')
  })

  it('hides once bound, without launchModel, or for another/absent harness', () => {
    expect(spawnModelOptions('claude-code', spawnRegistry, 'opus', true).models).toEqual([])
    expect(spawnModelOptions('codex', spawnRegistry, 'a', false).models).toEqual([])
    expect(spawnModelOptions(undefined, spawnRegistry, 'opus', false).models).toEqual([])
    expect(spawnModelOptions('claude-code', undefined, 'opus', false).models).toEqual([])
  })

  it('falls back to the default when the stored model is off this sheet', () => {
    // e.g. a value left over from another harness — never shown as selected.
    expect(spawnModelOptions('claude-code', spawnRegistry, 'grok-4.6', false).value).toBe('')
  })
})
