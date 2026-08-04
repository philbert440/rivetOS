/**
 * Pure unit tests for wiki extraction idempotency / pipeline-version policy.
 * No PG required.
 */

import { describe, it, expect } from 'vitest'
import { isExtractionCurrent } from './index-reader.js'
import { WIKI_PIPELINE_VERSION } from './prompts.js'

describe('isExtractionCurrent', () => {
  it('returns false when no extraction row exists', () => {
    expect(isExtractionCurrent(undefined)).toBe(false)
  })

  it('treats failed as not done', () => {
    expect(
      isExtractionCurrent({ status: 'failed', pipeline_version: WIKI_PIPELINE_VERSION }),
    ).toBe(false)
  })

  it('treats skipped as terminal at any pipeline version', () => {
    expect(isExtractionCurrent({ status: 'skipped', pipeline_version: 1 })).toBe(true)
    expect(
      isExtractionCurrent({ status: 'skipped', pipeline_version: WIKI_PIPELINE_VERSION }),
    ).toBe(true)
  })

  it('treats done at current pipeline as terminal', () => {
    expect(
      isExtractionCurrent({ status: 'done', pipeline_version: WIKI_PIPELINE_VERSION }),
    ).toBe(true)
  })

  it('requires re-mine when done under an older pipeline version', () => {
    expect(isExtractionCurrent({ status: 'done', pipeline_version: 1 })).toBe(false)
    expect(isExtractionCurrent({ status: 'done', pipeline_version: 2 })).toBe(false)
  })

  it('honors an explicit minPipelineVersion override', () => {
    expect(isExtractionCurrent({ status: 'done', pipeline_version: 2 }, 2)).toBe(true)
    expect(isExtractionCurrent({ status: 'done', pipeline_version: 2 }, 3)).toBe(false)
  })
})
