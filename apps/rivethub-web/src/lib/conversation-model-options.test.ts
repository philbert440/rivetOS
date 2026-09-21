import { describe, expect, it } from 'vitest'
import {
  conversationLaunch,
  conversationModelOptions as resolveOptions,
  conversationProtocolOwnership,
  isPreBind,
  launchModelOptions,
  needsRegistryBeforeSpawn,
  shouldPersistLaunchLatch,
  type ConversationTurnPick,
} from './conversation-model-options.js'
import { spawnModelEffort } from './harness-options.js'
import { launchStateWrite, mergeChatSettings, type ChatSettings } from '../stores/chat-settings.js'

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

describe('launchModelOptions (spawn-time, #814)', () => {
  const launchRegistry = [
    {
      harnessId: 'claude-code' as const,
      capabilities: {
        launchModel: true,
        models: [
          { id: 'fable', label: 'Fable' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    },
    {
      // A turn-only sheet (per-turn picker) must never feed the launch picker.
      harnessId: 'codex' as const,
      capabilities: {
        turnOptions: true,
        models: [{ id: 'a', label: 'Model A' }],
      },
    },
  ]
  it('lists the harness’s own models only when declared and pre-bind', () => {
    const r = launchModelOptions({
      preBind: true,
      harnessId: 'claude-code',
      registry: launchRegistry,
    })
    expect(r.models.map((m) => m.value)).toEqual(['fable', 'opus'])
    expect(r.value).toBe('')
    expect(r.clearModel).toBe(false)
    expect(r.vettedModelIds).toEqual(['fable', 'opus'])
    expect(r.defaultModelLabel).toBe('Harness default (Fable)')
  })
  it('never offers a turn-only sheet’s models or a sheet without the flag', () => {
    expect(
      launchModelOptions({ preBind: true, harnessId: 'codex', registry: launchRegistry }).models,
    ).toEqual([])
    const noFlag = [
      {
        harnessId: 'claude-code' as const,
        capabilities: { models: [{ id: 'opus', label: 'Opus' }] },
      },
    ]
    expect(
      launchModelOptions({ preBind: true, harnessId: 'claude-code', registry: noFlag }).models,
    ).toEqual([])
  })
  it('hides the picker once bound, even with a stored model (which it keeps)', () => {
    const r = launchModelOptions({
      preBind: false,
      harnessId: 'claude-code',
      registry: launchRegistry,
      model: 'opus',
    })
    // No picker offered once bound, but the launch model it spawned with is
    // retained (value) rather than erased.
    expect(r.models).toEqual([])
    expect(r.value).toBe('opus')
    expect(r.clearModel).toBe(false)
    // Ids stay vetted after the picker closes so a respawn can still send one.
    expect(r.vettedModelIds).toEqual(['fable', 'opus'])
  })
  it('keeps a valid stored model as the value', () => {
    const r = launchModelOptions({
      preBind: true,
      harnessId: 'claude-code',
      registry: launchRegistry,
      model: 'opus',
    })
    expect(r.value).toBe('opus')
    expect(r.clearModel).toBe(false)
  })
  it('clears an off-sheet stored model only before launch', () => {
    const pre = launchModelOptions({
      preBind: true,
      harnessId: 'claude-code',
      registry: launchRegistry,
      model: 'removed',
    })
    expect(pre.value).toBe('')
    expect(pre.clearModel).toBe(true)
    // A bound or already-launched conversation keeps the model it spawned with.
    const launched = launchModelOptions({
      preBind: false,
      harnessId: 'claude-code',
      registry: launchRegistry,
      model: 'removed',
    })
    expect(launched.models).toEqual([])
    expect(launched.value).toBe('removed')
    expect(launched.clearModel).toBe(false)
    expect(launched.vettedModelIds).toEqual(['fable', 'opus'])
  })
  it('names the marked default, else the first model, else a bare label', () => {
    const marked = [
      {
        harnessId: 'claude-code' as const,
        capabilities: {
          launchModel: true,
          models: [
            { id: 'opus', label: 'Opus 5' },
            { id: 'fable', label: 'Fable 5.1', default: true },
          ],
        },
      },
    ]
    expect(
      launchModelOptions({ preBind: true, harnessId: 'claude-code', registry: marked })
        .defaultModelLabel,
    ).toBe('Harness default (Fable 5.1)')
    expect(
      launchModelOptions({ preBind: true, harnessId: 'claude-code', registry: undefined })
        .defaultModelLabel,
    ).toBe('Harness default')
    expect(
      launchModelOptions({
        preBind: true,
        harnessId: 'claude-code',
        registry: [{ harnessId: 'claude-code', capabilities: { launchModel: true, models: [] } }],
      }).defaultModelLabel,
    ).toBe('Harness default')
  })
  it('preserves a stored model while the registry is pending, errored, or the row is missing', () => {
    // registry undefined (pending/errored) → sheet did not settle → preserve.
    // No separate `registry !== undefined` guard: unresolved means no vetted ids.
    expect(
      launchModelOptions({
        preBind: true,
        harnessId: 'claude-code',
        registry: undefined,
        model: 'opus',
      }),
    ).toEqual({
      models: [],
      value: 'opus',
      clearModel: false,
      defaultModelLabel: 'Harness default',
      vettedModelIds: undefined,
    })
    // empty registry / unknown harness id → row missing → preserve, send nothing.
    for (const harnessId of ['claude-code', 'grok-build'] as const) {
      const r = launchModelOptions({ preBind: true, harnessId, registry: [], model: 'opus' })
      expect(r.clearModel).toBe(false)
      expect(r.value).toBe('opus')
      expect(r.vettedModelIds).toBeUndefined()
    }
  })
})

describe('isPreBind', () => {
  const open = { bound: false, hasPty: false, launched: false, spawnInFlight: false }
  it('is open only before the first spawn, with no pty and no request in flight', () => {
    expect(isPreBind(open)).toBe(true)
    expect(isPreBind({ ...open, spawnInFlight: true })).toBe(false)
    // Inject 409 clears the pty; a conversation that already launched stays shut.
    expect(isPreBind({ ...open, launched: true })).toBe(false)
    expect(isPreBind({ ...open, bound: true })).toBe(false)
    expect(isPreBind({ ...open, hasPty: true })).toBe(false)
  })
})

describe('conversationLaunch', () => {
  const registry = [
    {
      harnessId: 'claude-code' as const,
      capabilities: {
        launchModel: true,
        models: [
          { id: 'fable', label: 'Fable 5.1', default: true },
          { id: 'opus', label: 'Opus 5' },
        ],
      },
    },
  ]
  it('resolves an agent-only claude draft onto its sheet and sends an on-sheet pick', () => {
    const r = conversationLaunch({
      settings: { agent: 'claude', model: 'opus', effort: 'medium', harnessEffort: 'max' },
      registry,
      preBind: true,
    })
    expect(r.harnessId).toBe('claude-code')
    expect(r.options.models.map((m) => m.value)).toEqual(['fable', 'opus'])
    expect(r.options.defaultModelLabel).toBe('Harness default (Fable 5.1)')
    // effort stays preset-only.
    expect(r.spawn).toEqual({ model: 'opus' })
  })
  it('prefers the row harness over the roster command', () => {
    const r = conversationLaunch({
      itemHarnessId: 'claude-code',
      settings: { agent: 'grok-fast', model: 'opus' },
      registry,
      preBind: true,
    })
    expect(r.harnessId).toBe('claude-code')
    expect(r.options.models.map((m) => m.value)).toEqual(['fable', 'opus'])
    expect(r.spawn).toEqual({ model: 'opus' })
  })
  it('offers no picker and sends no model for an agent with no harness', () => {
    const r = conversationLaunch({
      settings: { agent: 'grok-fast', model: 'opus', effort: 'medium' },
      registry,
      preBind: true,
    })
    expect(r.harnessId).toBeUndefined()
    expect(r.options.models).toEqual([])
    expect(r.spawn).toEqual({})
  })
  it('leaves a preset thread spawn flags unchanged', () => {
    const r = conversationLaunch({
      settings: {
        agent: 'claude',
        harnessId: 'claude-code',
        model: 'provider model',
        effort: 'medium',
        harnessEffort: 'high',
      },
      registry,
      preBind: true,
    })
    expect(r.harnessId).toBe('claude-code')
    expect(r.options.models.map((m) => m.value)).toEqual(['fable', 'opus'])
    expect(r.spawn).toEqual({ model: 'provider model', effort: 'high' })
  })
  it('still sends an on-sheet model after the picker closes, and nothing while the registry is pending', () => {
    const closed = conversationLaunch({
      settings: { agent: 'claude', model: 'opus' },
      registry,
      preBind: false,
    })
    expect(closed.options.models).toEqual([])
    expect(closed.spawn).toEqual({ model: 'opus' })
    expect(
      conversationLaunch({
        settings: { agent: 'claude', model: 'opus' },
        registry: undefined,
        preBind: true,
      }).spawn,
    ).toEqual({})
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
  it('agent or harness changes clear turn overrides AND the launch model (#814)', () => {
    const current = { ...launch, turnPick: pick }
    expect(mergeChatSettings(current, { agent: 'grok' }).turnPick).toBeUndefined()
    expect(mergeChatSettings(current, { agent: 'grok' }).model).toBeUndefined()
    expect(mergeChatSettings(current, { harnessId: 'grok-build' }).turnPick).toBeUndefined()
    expect(mergeChatSettings(current, { harnessId: 'grok-build' }).model).toBeUndefined()
    // Same agent/harness (re-apply) or an unrelated field keeps both.
    expect(mergeChatSettings(current, { agent: 'codex' }).turnPick).toEqual(pick)
    expect(mergeChatSettings(current, { agent: 'codex' }).model).toBe(launch.model)
    expect(mergeChatSettings(current, { effort: 'high' }).turnPick).toEqual(pick)
    expect(mergeChatSettings(current, { effort: 'high' }).model).toBe(launch.model)
  })
  it('clears the launch model on agent change even with no turn pick stored', () => {
    expect(
      mergeChatSettings({ agent: 'claude', effort: 'medium', model: 'opus' }, { agent: 'grok' })
        .model,
    ).toBeUndefined()
  })
  it('keeps a model the same patch sets when the agent or harness changes (#821)', () => {
    const current: ChatSettings = {
      agent: 'claude',
      effort: 'medium',
      harnessId: 'claude-code',
      model: 'fable',
      turnPick: pick,
    }
    const next = mergeChatSettings(current, { harnessId: 'grok-build', model: 'grok-4' })
    expect(next.model).toBe('grok-4')
    expect(next.harnessId).toBe('grok-build')
    // Turn overrides still drop; only an explicit model survives the clear.
    expect(next.turnPick).toBeUndefined()
    expect(mergeChatSettings(current, { harnessId: 'grok-build' }).model).toBeUndefined()
    expect(mergeChatSettings(current, { agent: 'grok', model: 'grok-4' }).model).toBe('grok-4')
  })
  it('resets launched on an agent or harness change and keeps it otherwise', () => {
    const current: ChatSettings = {
      agent: 'codex',
      effort: 'medium',
      model: 'opus',
      launched: true,
    }
    const switched = mergeChatSettings(current, { agent: 'claude' })
    expect(switched.launched).toBeUndefined()
    expect(switched.model).toBeUndefined()
    expect(switched.agent).toBe('claude')
    // A patch must not carry the latch across the identity change.
    expect(mergeChatSettings(current, { agent: 'claude', launched: true }).launched).toBeUndefined()
    expect(mergeChatSettings(current, { launched: true }).launched).toBe(true)
    expect(mergeChatSettings(current, { agent: 'codex' }).launched).toBe(true)
    expect(mergeChatSettings(current, { agent: 'codex' }).model).toBe('opus')
    expect(mergeChatSettings(current, { harnessId: 'grok-build' }).launched).toBeUndefined()
  })
})

describe('registry wait before spawn', () => {
  it('waits only for a stored model with no harness while the registry is unsettled', () => {
    expect(
      needsRegistryBeforeSpawn({
        model: 'opus',
        harnessId: undefined,
        registrySettled: false,
      }),
    ).toBe(true)
    expect(
      needsRegistryBeforeSpawn({ model: '  ', harnessId: undefined, registrySettled: false }),
    ).toBe(false)
    expect(needsRegistryBeforeSpawn({ model: undefined, registrySettled: false })).toBe(false)
    expect(
      needsRegistryBeforeSpawn({
        model: 'opus',
        harnessId: 'claude-code',
        registrySettled: false,
      }),
    ).toBe(false)
    expect(
      needsRegistryBeforeSpawn({ model: 'opus', harnessId: undefined, registrySettled: true }),
    ).toBe(false)
  })
})

describe('launch latch identity', () => {
  it('latches only when the captured agent and harness are still current', () => {
    const captured = { agent: 'codex', harnessId: 'codex' as const }
    expect(shouldPersistLaunchLatch(captured, { ...captured, launched: false })).toBe(true)
    expect(shouldPersistLaunchLatch(captured, { ...captured, launched: true })).toBe(false)
    expect(shouldPersistLaunchLatch(captured, { agent: 'claude', harnessId: 'codex' })).toBe(false)
    expect(shouldPersistLaunchLatch(captured, { agent: 'codex', harnessId: 'grok-build' })).toBe(
      false,
    )
    expect(shouldPersistLaunchLatch({ agent: 'codex' }, { agent: 'codex', launched: true })).toBe(
      false,
    )
    // Same agent re-selected is not a change; a missing record matches a missing agent.
    expect(shouldPersistLaunchLatch({ agent: 'codex' }, { agent: 'codex' })).toBe(true)
    expect(shouldPersistLaunchLatch({}, undefined)).toBe(true)
    expect(shouldPersistLaunchLatch({ agent: undefined }, { agent: '' })).toBe(true)
  })
})

describe('launch-state writes', () => {
  const legacy: ChatSettings = {
    agent: 'claude',
    effort: 'high',
    model: 'opus',
    harnessId: 'claude-code',
    systemPrompt: 'be brief',
  }
  const patch = { launched: true as const }
  it('migrates a legacy record when the canonical key is absent', () => {
    expect(launchStateWrite(undefined, legacy, patch)).toEqual({ ...legacy, ...patch })
  })
  it('uses the patch alone when a canonical record exists', () => {
    expect(launchStateWrite(legacy, legacy, patch)).toBe(patch)
  })
  it('uses the patch alone when neither record exists', () => {
    expect(launchStateWrite(undefined, undefined, patch)).toBe(patch)
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
