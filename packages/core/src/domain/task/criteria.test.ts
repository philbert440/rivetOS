import { describe, it, expect } from 'vitest'
import {
  CRITERIA_POLICY_OFF,
  CriteriaRequiredError,
  CriteriaShapeError,
  criteriaPolicyFromConfig,
  normalizeCriteria,
} from './criteria.js'

const ON = criteriaPolicyFromConfig({ enabled: true })

describe('criteriaPolicyFromConfig', () => {
  it('disabled/absent section → OFF policy', () => {
    expect(criteriaPolicyFromConfig(undefined)).toEqual(CRITERIA_POLICY_OFF)
    expect(criteriaPolicyFromConfig({ enabled: false })).toEqual(CRITERIA_POLICY_OFF)
  })

  it('enabled defaults: require + derive on, heartbeats skipped', () => {
    expect(ON).toEqual({
      enabled: true,
      requireCriteria: true,
      deriveInternal: true,
      skipOrigins: ['heartbeat'],
    })
  })
})

describe('normalizeCriteria policy paths', () => {
  it('explicit criteria pass through validated (kind defaults to manual)', () => {
    const out = normalizeCriteria(
      {
        goal: 'g',
        origin: 'api',
        acceptanceCriteria: [{ id: 'c1', description: 'tests pass' }],
      },
      CRITERIA_POLICY_OFF,
    )
    expect(out).toEqual([{ id: 'c1', description: 'tests pass', kind: 'manual' }])
  })

  it('policy off + empty → [] for every origin', () => {
    for (const origin of ['api', 'tool', 'mesh', 'heartbeat']) {
      expect(normalizeCriteria({ goal: 'g', origin }, CRITERIA_POLICY_OFF)).toEqual([])
    }
  })

  it('enabled: api empty → CriteriaRequiredError; internal → derived goal criterion', () => {
    expect(() => normalizeCriteria({ goal: 'g', origin: 'api' }, ON)).toThrow(
      CriteriaRequiredError,
    )
    const derived = normalizeCriteria({ goal: 'ship it', origin: 'tool' }, ON)
    expect(derived).toHaveLength(1)
    expect(derived[0]).toMatchObject({ id: 'goal', kind: 'manual' })
    expect(derived[0].description).toContain('ship it')
  })

  it('enabled: heartbeat stays skip-listed; mesh derives', () => {
    expect(normalizeCriteria({ goal: 'g', origin: 'heartbeat' }, ON)).toEqual([])
    expect(normalizeCriteria({ goal: 'g', origin: 'mesh' }, ON)).toHaveLength(1)
  })

  it("origin 'eval' is structurally exempt — even if skip_origins is overridden away", () => {
    const noSkips = criteriaPolicyFromConfig({ enabled: true, skip_origins: [] })
    expect(normalizeCriteria({ goal: 'verify x', origin: 'eval' }, noSkips)).toEqual([])
  })

  it('skip_origins override replaces the default list', () => {
    const custom = criteriaPolicyFromConfig({ enabled: true, skip_origins: ['mesh'] })
    expect(normalizeCriteria({ goal: 'g', origin: 'mesh' }, custom)).toEqual([])
    expect(normalizeCriteria({ goal: 'g', origin: 'heartbeat' }, custom)).toHaveLength(1)
  })

  it('require off / derive off honored', () => {
    const lax = criteriaPolicyFromConfig({ enabled: true, require_criteria: false })
    expect(normalizeCriteria({ goal: 'g', origin: 'api' }, lax)).toEqual([])
    const noDerive = criteriaPolicyFromConfig({ enabled: true, derive_internal: false })
    expect(normalizeCriteria({ goal: 'g', origin: 'tool' }, noDerive)).toEqual([])
  })

  it('shape errors regardless of policy: non-array, bad kind, dupes, empty id', () => {
    const bad = (criteria: unknown) => () =>
      normalizeCriteria({ goal: 'g', origin: 'api', acceptanceCriteria: criteria }, CRITERIA_POLICY_OFF)
    expect(bad('nope')).toThrow(CriteriaShapeError)
    expect(bad([{ id: 'a', description: 'x', kind: 'vibes' }])).toThrow(/kind/)
    expect(
      bad([
        { id: 'a', description: 'x' },
        { id: 'a', description: 'y' },
      ]),
    ).toThrow(/duplicate/)
    expect(bad([{ id: '  ', description: 'x' }])).toThrow(/id/)
    expect(bad([{ id: 'a', description: '' }])).toThrow(/description/)
    expect(bad([{ id: 'a', description: 'x', check: 42 }])).toThrow(/check/)
  })
})
