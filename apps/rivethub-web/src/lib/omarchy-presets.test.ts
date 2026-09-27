import { describe, expect, it } from 'vitest'
import { contrastRatio, omarchyAppTokens } from './omarchy-theme.js'
import { DEFAULT_OMARCHY_PRESET, OMARCHY_PRESETS, omarchyPresetColors } from './omarchy-presets.js'

describe('OMARCHY_PRESETS', () => {
  it('has unique ids and includes the default', () => {
    const ids = OMARCHY_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_OMARCHY_PRESET)
  })

  it.each(OMARCHY_PRESETS.map((p) => [p.id]))('%s parses with the live-theme parser', (id) => {
    expect(omarchyPresetColors(id)).not.toBeNull()
  })

  it('reads light themes as light and the rest as dark', () => {
    const light = OMARCHY_PRESETS.filter((p) => omarchyPresetColors(p.id)?.mode === 'light')
    // Omarchy's Rosé Pine is the light Dawn variant.
    expect(light.map((p) => p.id).sort()).toEqual([
      'catppuccin-latte',
      'flexoki-light',
      'rose-pine',
    ])
  })

  it.each(OMARCHY_PRESETS.map((p) => [p.id]))('%s keeps body text readable', (id) => {
    const colors = omarchyPresetColors(id)!
    const t = omarchyAppTokens(colors)
    expect(contrastRatio(t['--color-ink']!, t['--color-bg']!)).toBeGreaterThanOrEqual(4.5)
  })

  it('returns null for an unknown id', () => {
    expect(omarchyPresetColors('not-a-theme')).toBeNull()
  })
})
