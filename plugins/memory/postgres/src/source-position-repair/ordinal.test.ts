import { eventIdFromContent } from '@rivetos/capture-core'
import { describe, expect, it } from 'vitest'
import { ingestEventId } from '../tools/write-tools.ts'
import {
  SOURCE_ORDINAL_STRIDE,
  derivedCaptureEventId,
  derivedIngestEventId,
  rewriteBackfillSourceId,
  sourceOrdinal,
  sourceSubIndex,
} from './ordinal.ts'

describe('source ordinal recompute', () => {
  it('round-trips position and sub through the capture stride', () => {
    expect(SOURCE_ORDINAL_STRIDE).toBe(1000)
    expect(sourceOrdinal(12, 3)).toBe(12003)
    expect(sourceSubIndex(12, 12003)).toBe(3)
    expect(sourceSubIndex(12, 12)).toBeUndefined()
  })

  it('recomputes event_id with capture-core occurrence, not a source-id rename', () => {
    const base = {
      sessionKey: 'synth-repair-session',
      role: 'assistant',
      content: 'same-text',
      toolName: 'shell',
      toolArgs: { cmd: 'echo' },
    }
    const oldOrdinal = sourceOrdinal(4, 1)
    const newOrdinal = sourceOrdinal(9, 1)
    const oldId = derivedCaptureEventId({ ...base, ordinal: oldOrdinal })
    const newId = derivedCaptureEventId({ ...base, ordinal: newOrdinal })
    expect(oldId).toBe(eventIdFromContent({ ...base, occurrence: oldOrdinal }))
    expect(newId).not.toBe(oldId)
    expect(newId).toBe(eventIdFromContent({ ...base, occurrence: newOrdinal }))
  })

  it('hashes grok-bot tool-result content the same way capture-core does', () => {
    const content = ''
    const toolResult = 'stdout-from-tool'
    const hashed = content || toolResult
    const ordinal = sourceOrdinal(5, 1)
    expect(
      derivedCaptureEventId({
        sessionKey: 'synth-repair-session',
        role: 'tool',
        content: hashed,
        toolName: 'shell',
        ordinal,
      }),
    ).toBe(
      eventIdFromContent({
        sessionKey: 'synth-repair-session',
        role: 'tool',
        content: hashed,
        toolName: 'shell',
        occurrence: ordinal,
      }),
    )
  })

  it('pins ingestEventId so memory-ingest rows also recompute occurrence', () => {
    const parts = {
      sessionId: 'synth-repair-session',
      agent: 'synth-repair-agent',
      role: 'user',
      content: 'same-text',
      ordinal: sourceOrdinal(4, 0),
    }
    expect(derivedIngestEventId(parts)).toBe(ingestEventId(parts))
    expect(derivedIngestEventId({ ...parts, ordinal: sourceOrdinal(2, 0) })).not.toBe(
      ingestEventId(parts),
    )
  })

  it('rewrites a backfill source_id only when the from-position matches', () => {
    expect(rewriteBackfillSourceId('readtranscript:slug:4:1', 4, 9, 1)).toBe(
      'readtranscript:slug:9:1',
    )
    expect(rewriteBackfillSourceId('readtranscript:slug:4:1', 5, 9, 1)).toBeUndefined()
    expect(rewriteBackfillSourceId('hook-native-id', 4, 9, 1)).toBeUndefined()
  })
})
