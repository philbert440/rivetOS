import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSourcePositionRepairPlan } from './plan.ts'

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error('expected parse to reject')
  } catch (error) {
    if (error instanceof Error && error.message === 'expected parse to reject') throw error
    expect(error).toMatchObject({ code })
  }
}

const sample = {
  schemaVersion: 1 as const,
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  sessionKey: 'synth-repair-session',
  agent: 'synth-repair-agent',
  provenanceRef: 'synth-evidence-ref',
  expectedStateHash: 'ab'.repeat(32),
  relocations: [
    {
      messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      from: {
        position: 4,
        ordinal: 4000,
        eventId: 'evt-1',
        captureSource: 'synth-capture',
      },
      to: { position: 9 },
    },
  ],
}

describe('source position repair plan', () => {
  it('parses an explicit UUID mapping and rejects destination timestamps', () => {
    expect(parseSourcePositionRepairPlan(sample).relocations[0].to.position).toBe(9)
    expectCode(
      () =>
        parseSourcePositionRepairPlan({
          ...sample,
          relocations: [
            {
              ...sample.relocations[0],
              to: { position: 9, createdAt: '2026-01-01T00:00:00.000Z' },
            },
          ],
        }),
      'timestamp_unproven',
    )
  })

  it('rejects empty mappings and extra keys', () => {
    expectCode(() => parseSourcePositionRepairPlan({ ...sample, relocations: [] }), 'invalid_plan')
    expectCode(() => parseSourcePositionRepairPlan({ ...sample, autoMerge: true }), 'invalid_plan')
  })

  it('leaves captureBatch insert-only for position metadata', () => {
    const src = readFileSync(resolve(__dirname, '../tools/write-tools.ts'), 'utf8')
    expect(src).toContain('INSERT INTO ros_messages')
    expect(src).toContain('pg_advisory_xact_lock(hashtext($1))')
    expect(src).not.toMatch(/UPDATE ros_messages[\s\S]*position/)
  })
})
