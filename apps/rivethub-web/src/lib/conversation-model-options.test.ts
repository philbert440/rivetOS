import { describe, expect, it } from 'vitest'
import {
  conversationModelOptions,
  type ConversationTurnPick,
} from './conversation-model-options.js'
import { spawnModelEffort } from './harness-options.js'
import { mergeChatSettings, type ChatSettings } from '../stores/chat-settings.js'

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
