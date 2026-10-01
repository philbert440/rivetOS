import { describe, expect, it } from 'vitest'
import { parseRecompileResult, parseWikiPatches } from '@rivetos/memory-postgres'
import { rejectUnparseable, UNPARSEABLE_JSON } from './wiki-accept.js'

describe('rejectUnparseable', () => {
  it('matches what both wiki parsers say about a reply that is not JSON', () => {
    expect(rejectUnparseable(parseWikiPatches('no json here', 'now').rejected)).toBe(
      UNPARSEABLE_JSON,
    )
    expect(rejectUnparseable(parseRecompileResult('no json here', 'slug', 'now').rejected)).toBe(
      UNPARSEABLE_JSON,
    )
  })

  it('accepts JSON even when the parser drops entries from it', () => {
    expect(rejectUnparseable(parseWikiPatches('[{"slug": ""}]', 'now').rejected)).toBeNull()
    expect(rejectUnparseable(parseWikiPatches('[]', 'now').rejected)).toBeNull()
    expect(rejectUnparseable(parseRecompileResult('{}', 'slug', 'now').rejected)).toBeNull()
  })
})
