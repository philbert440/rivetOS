import { describe, expect, it } from 'vitest'
import {
  conversationModelOptions as resolveOptions,
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
