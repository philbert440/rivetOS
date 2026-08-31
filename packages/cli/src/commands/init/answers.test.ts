import { describe, it, expect } from 'vitest'
import {
  MissingAnswerError,
  interpretAnswers,
  isDefaultMarker,
  parseAnswersJson,
} from './answers.js'

const ENV = { configExists: false, dockerAvailable: true }

function happy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deployment: 'manual',
    agents: [
      {
        name: 'rivet',
        provider: 'xai',
        apiKey: 'xai-test-key',
        model: 'grok-4-1-fast-reasoning',
        thinking: 'medium',
      },
    ],
    postgresUrl: 'postgres://u:p@localhost:5432/rivetos',
    joinMesh: false,
    ownerId: 'owner',
    confirm: true,
    ...overrides,
  }
}

describe('parseAnswersJson', () => {
  it('parses a JSON object', () => {
    expect(parseAnswersJson('{"deployment":"manual"}')).toEqual({ deployment: 'manual' })
  })

  it('rejects invalid JSON', () => {
    expect(() => parseAnswersJson('{')).toThrow(/not valid JSON/)
  })

  it('rejects a JSON array', () => {
    expect(() => parseAnswersJson('[]')).toThrow(/must be a JSON object/)
  })
})

describe('isDefaultMarker', () => {
  it('accepts { default: true } and nothing else', () => {
    expect(isDefaultMarker({ default: true })).toBe(true)
    expect(isDefaultMarker({ default: true, extra: 1 })).toBe(false)
    expect(isDefaultMarker(true)).toBe(false)
    expect(isDefaultMarker({ default: false })).toBe(false)
  })
})

describe('interpretAnswers', () => {
  it('happy path: full explicit answers without mesh', () => {
    const result = interpretAnswers(happy(), ENV)
    expect(result.deployment).toBe('manual')
    expect(result.agents).toEqual([
      {
        name: 'rivet',
        provider: 'xai',
        apiKey: 'xai-test-key',
        model: 'grok-4-1-fast-reasoning',
        thinking: 'medium',
        baseUrl: undefined,
      },
    ])
    expect(result.postgresUrl).toBe('postgres://u:p@localhost:5432/rivetos')
    expect(result.meshJoin).toBeUndefined()
    expect(result.ownerId).toBe('owner')
    expect(result.confirm).toBe(true)
  })

  it('happy path: joinMesh collects hub/name/advertise', () => {
    const result = interpretAnswers(
      happy({
        joinMesh: true,
        meshHub: 'rivet@192.0.2.10',
        meshName: 'node-a',
        meshAdvertise: '192.0.2.11',
      }),
      ENV,
    )
    expect(result.meshJoin).toEqual({
      hub: 'rivet@192.0.2.10',
      name: 'node-a',
      advertise: '192.0.2.11',
    })
  })

  it('opt-in default marker uses interactive defaults', () => {
    const result = interpretAnswers(
      happy({
        ownerId: { default: true },
        confirm: { default: true },
        joinMesh: { default: true },
        agents: [
          {
            name: { default: true },
            provider: 'xai',
            apiKey: 'xai-test-key',
            model: { default: true },
            thinking: { default: true },
          },
        ],
      }),
      ENV,
    )
    expect(result.ownerId).toBe('owner')
    expect(result.confirm).toBe(true)
    expect(result.meshJoin).toBeUndefined()
    expect(result.agents[0]?.name).toBe('rivet')
    expect(result.agents[0]?.thinking).toBe('medium')
    expect(result.agents[0]?.model).toBe('grok-4-1-fast-reasoning')
  })

  it('errors naming the missing top-level key', () => {
    const rest = happy()
    delete rest.deployment
    expect(() => interpretAnswers(rest, ENV)).toThrow(MissingAnswerError)
    try {
      interpretAnswers(rest, ENV)
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAnswerError)
      expect((err as MissingAnswerError).key).toBe('deployment')
      expect((err as Error).message).toContain('"deployment"')
    }
  })

  it('errors naming a missing nested agent key', () => {
    const answers = happy({
      agents: [{ name: 'rivet', model: 'm', thinking: 'off' }],
    })
    expect(() => interpretAnswers(answers, ENV)).toThrow(
      /missing required key "agents\[0\]\.provider"/,
    )
  })

  it('errors when joinMesh is true but meshHub is missing', () => {
    expect(() => interpretAnswers(happy({ joinMesh: true, meshName: 'node-a' }), ENV)).toThrow(
      /missing required key "meshHub"/,
    )
  })

  it('does not require wizard keys when existingConfig is deploy', () => {
    const result = interpretAnswers(
      { existingConfig: 'deploy', deployNow: false },
      { configExists: true, dockerAvailable: true },
    )
    expect(result.existingAction).toBe('deploy')
    expect(result.agents).toEqual([])
    expect(result.deployNow).toBe(false)
  })

  it('requires existingConfig when a config already exists', () => {
    expect(() =>
      interpretAnswers(happy(), { configExists: true, dockerAvailable: true }),
    ).toThrow(/missing required key "existingConfig"/)
  })

  it('rejects { default: true } on a prompt with no default', () => {
    expect(() =>
      interpretAnswers(happy({ deployment: { default: true } }), ENV),
    ).toThrow(/requested default but this prompt has no default/)
  })
})
