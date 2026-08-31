import { describe, expect, it } from 'vitest'
import { EMBED_MODEL_REQUIRED, memoryEmbedGuardError } from './embed-guard.js'

describe('mcp-sidecar memory embed guard', () => {
  it('does not fail when embed URL is set without a model if PG is unset', () => {
    expect(memoryEmbedGuardError(undefined, 'http://127.0.0.1:9401', undefined)).toBeNull()
    expect(memoryEmbedGuardError('', 'http://127.0.0.1:9401', undefined)).toBeNull()
  })

  it('fails when PG and embed URL are set without a model', () => {
    const pg = 'postgres://rivet@localhost/test'
    const url = 'http://127.0.0.1:9401'
    expect(memoryEmbedGuardError(pg, url, undefined)).toBe(EMBED_MODEL_REQUIRED)
    expect(memoryEmbedGuardError(pg, url, '')).toBe(EMBED_MODEL_REQUIRED)
  })

  it('passes when PG, embed URL, and model are all set', () => {
    expect(
      memoryEmbedGuardError(
        'postgres://rivet@localhost/test',
        'http://127.0.0.1:9401',
        'text-embedding-3-small',
      ),
    ).toBeNull()
  })

  it('passes when PG is set but embed URL is not (FTS-only memory)', () => {
    const pg = 'postgres://rivet@localhost/test'
    expect(memoryEmbedGuardError(pg, undefined, undefined)).toBeNull()
    expect(memoryEmbedGuardError(pg, '', undefined)).toBeNull()
  })
})
