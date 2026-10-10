import { describe, expect, it } from 'vitest'
import {
  combo,
  comboFromEvent,
  formatCombo,
  matchCombo,
  normalizeCombos,
  sameCombo,
} from './key-combo.js'

function ev(
  key: string,
  mods: Partial<{ code: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {},
) {
  return {
    key,
    code: mods.code ?? '',
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
  }
}

describe('matchCombo', () => {
  it('matches letters in either case but not with extra modifiers', () => {
    expect(matchCombo(combo('h'), ev('h'))).toBe(true)
    expect(matchCombo(combo('h'), ev('H'))).toBe(true)
    expect(matchCombo(combo('h'), ev('h', { ctrl: true }))).toBe(false)
    expect(matchCombo(combo('h'), ev('H', { shift: true }))).toBe(false)
  })

  it('lets punctuation ignore Shift, since Shift is how it is typed', () => {
    expect(matchCombo(combo('?'), ev('?', { shift: true }))).toBe(true)
    expect(matchCombo(combo('?'), ev('?'))).toBe(true)
  })

  it('matches code chords by physical key with exact modifiers', () => {
    const c = combo('e', { code: 'KeyE', ctrl: true, shift: true })
    expect(matchCombo(c, ev('E', { code: 'KeyE', ctrl: true, shift: true }))).toBe(true)
    expect(matchCombo(c, ev('e', { code: 'KeyE', ctrl: true }))).toBe(false)
  })
})

describe('comboFromEvent', () => {
  it('ignores a bare modifier press', () => {
    expect(comboFromEvent(ev('Control', { ctrl: true }))).toBeNull()
  })

  it('records a Ctrl chord by code and a bare key by key', () => {
    expect(formatCombo(comboFromEvent(ev('K', { code: 'KeyK', ctrl: true, shift: true }))!)).toBe(
      'Ctrl+Shift+K',
    )
    expect(comboFromEvent(ev('G', { code: 'KeyG', shift: true }))).toMatchObject({
      key: 'g',
      shift: true,
    })
  })

  it('records what then matches the same press', () => {
    const press = ev(' ', { code: 'Space', alt: true })
    const recorded = comboFromEvent(press)!
    expect(matchCombo(recorded, press)).toBe(true)
  })
})

describe('formatCombo', () => {
  it('spells modifiers and named keys', () => {
    expect(formatCombo(combo(' ', { code: 'Space', ctrl: true }))).toBe('Ctrl+Space')
    expect(formatCombo(combo('ArrowRight'))).toBe('→')
    expect(formatCombo(combo('Escape'))).toBe('Esc')
    expect(formatCombo(combo('?', { shift: true }))).toBe('?')
    expect(formatCombo(combo('Delete', { shift: true }))).toBe('Shift+Delete')
  })

  it('treats a code chord and its key spelling as the same shortcut', () => {
    expect(sameCombo(combo('j', { code: 'KeyJ', ctrl: true }), combo('j', { ctrl: true }))).toBe(
      true,
    )
  })
})

describe('normalizeCombos', () => {
  it('drops malformed entries', () => {
    expect(normalizeCombos('nope')).toBeUndefined()
    expect(normalizeCombos([{ key: 'h' }, { key: 3 }, null, { key: '', code: '' }])).toEqual([
      combo('h'),
    ])
  })
})
