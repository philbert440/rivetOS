import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'
import { classifyUnembeddable } from './classify.js'

describe('classifyUnembeddable', () => {
  it('returns null for normal text', () => {
    const result = classifyUnembeddable('This is normal content')
    assert.equal(result, null)
  })

  it('returns null for null input', () => {
    const result = classifyUnembeddable(null)
    assert.equal(result, null)
  })

  it('returns null for undefined input', () => {
    const result = classifyUnembeddable(undefined)
    assert.equal(result, null)
  })

  it('returns null for empty string', () => {
    const result = classifyUnembeddable('')
    assert.equal(result, null)
  })

  it('returns null for non-string input', () => {
    const result = classifyUnembeddable(42 as never)
    assert.equal(result, null)
  })

  it('detects [media attached: ...] marker (lowercase)', () => {
    const result = classifyUnembeddable('[media attached: image.png]')
    assert.equal(result, 'media-marker')
  })

  it('detects [MEDIA ATTACHED: ...] marker (uppercase)', () => {
    const result = classifyUnembeddable('[MEDIA ATTACHED: VIDEO]')
    assert.equal(result, 'media-marker')
  })

  it('detects [Media Attached: ...] marker (mixed case)', () => {
    const result = classifyUnembeddable('[Media Attached: document]')
    assert.equal(result, 'media-marker')
  })

  it('ignores [media attached] when surrounded by text', () => {
    const result = classifyUnembeddable('Some text [media attached: image] more text')
    // Media marker check uses trimStart() which removes leading whitespace only
    // The marker must be at the start after trimming
    assert.equal(result, null)
  })

  it('detects MEDIA: prefix (uppercase)', () => {
    const result = classifyUnembeddable('MEDIA: some video data')
    assert.equal(result, 'media-prefix')
  })

  it('detects media: prefix (lowercase)', () => {
    const result = classifyUnembeddable('media: some audio data')
    assert.equal(result, 'media-prefix')
  })

  it('ignores media: when not at start after trim', () => {
    const result = classifyUnembeddable('Some text media: data')
    assert.equal(result, null)
  })

  it('detects data:image/png;base64 with 200+ base64 chars', () => {
    const base64Payload = 'A'.repeat(250)
    const result = classifyUnembeddable(`data:image/png;base64,${base64Payload}`)
    assert.equal(result, 'base64-data-url')
  })

  it('ignores data:image/png;base64 with fewer than 200 base64 chars', () => {
    const base64Payload = 'A'.repeat(100)
    const result = classifyUnembeddable(`data:image/png;base64,${base64Payload}`)
    assert.equal(result, null)
  })

  it('detects PNG magic bytes (iVBORw0KGgo) with 200+ chars', () => {
    const base64Payload = 'A'.repeat(250)
    const result = classifyUnembeddable(`iVBORw0KGgo${base64Payload}`)
    assert.equal(result, 'base64-png')
  })

  it('ignores PNG magic bytes with fewer than 200 chars', () => {
    const result = classifyUnembeddable('iVBORw0KGgo' + 'A'.repeat(100))
    assert.equal(result, null)
  })

  it('detects JPEG magic bytes (/9j/) with 500+ chars', () => {
    const base64Payload = 'A'.repeat(550)
    const result = classifyUnembeddable(`/9j/${base64Payload}`)
    assert.equal(result, 'base64-jpeg')
  })

  it('ignores JPEG magic bytes with fewer than 500 chars', () => {
    const result = classifyUnembeddable('/9j/' + 'A'.repeat(400))
    assert.equal(result, null)
  })

  it('detects long base64 blob (1500+ chars) with >95% base64 chars', () => {
    const base64Payload = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(
      30,
    )
    const result = classifyUnembeddable(base64Payload)
    assert.equal(result, 'base64-blob')
  })

  it('ignores 1500+ char string with <95% base64 chars', () => {
    const mixed = 'hello world'.repeat(200) // mostly non-base64
    const result = classifyUnembeddable(mixed)
    assert.equal(result, null)
  })

  it('handles base64 with padding (=) characters', () => {
    const base64Payload = 'A'.repeat(1500) + '=='
    const result = classifyUnembeddable(base64Payload)
    assert.equal(result, 'base64-blob')
  })

  it('handles mixed case base64 chars', () => {
    const base64Payload = 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTt'.repeat(50)
    const result = classifyUnembeddable(base64Payload)
    assert.equal(result, 'base64-blob')
  })

  it('ignores normal text that contains some base64-like sequences', () => {
    const text = 'This is normal content with ABC123 and some stuff'
    const result = classifyUnembeddable(text)
    assert.equal(result, null)
  })

  it('detects media marker even with leading whitespace', () => {
    const result = classifyUnembeddable('  \n\t[media attached: video]')
    assert.equal(result, 'media-marker')
  })

  it('prioritizes media-marker over other patterns', () => {
    // If content has both marker and base64, media-marker is checked first
    const base64Payload = 'A'.repeat(250)
    const content = `[media attached: image] ${base64Payload}`
    const result = classifyUnembeddable(content)
    assert.equal(result, 'media-marker')
  })

  it('distinguishes between different base64 formats', () => {
    const pngContent = 'iVBORw0KGgo' + 'X'.repeat(250)
    const jpegContent = '/9j/' + 'Y'.repeat(550)
    const urlContent = 'data:image/jpeg;base64,' + 'Z'.repeat(250)

    assert.equal(classifyUnembeddable(pngContent), 'base64-png')
    assert.equal(classifyUnembeddable(jpegContent), 'base64-jpeg')
    assert.equal(classifyUnembeddable(urlContent), 'base64-data-url')
  })

  it('returns early on first match (checking order)', () => {
    // [media attached] is checked before base64 patterns
    const content = '[media attached: stuff]'
    const result = classifyUnembeddable(content)
    assert.equal(result, 'media-marker')
  })
})
