import { describe, expect, it } from 'vitest'
import { shellKeysForPlatform } from './shell-keys.js'

describe('shellKeysForPlatform', () => {
  it('handles chords where the application menu is nulled', () => {
    expect(shellKeysForPlatform('linux')).toBe(true)
    expect(shellKeysForPlatform('win32')).toBe(true)
    expect(shellKeysForPlatform('darwin')).toBe(false)
    expect(shellKeysForPlatform(undefined)).toBe(false)
  })
})
