import { describe, expect, it } from 'vitest'
import { accentFor } from './agent-accent.js'
import { harnessAccent } from './harness-colors.js'

describe('accentFor', () => {
  it('lets a valid preset colour win', () => {
    expect(
      accentFor({
        presetColor: '#3b82f6',
        harnessId: 'claude-code',
        command: 'grok',
      }),
    ).toBe('#3b82f6')
  })

  it('accepts 3-digit hex', () => {
    expect(accentFor({ presetColor: '#fff', command: 'grok' })).toBe('#fff')
  })

  it('trims preset colour before validating', () => {
    expect(accentFor({ presetColor: '  #CC785C  ', command: 'grok' })).toBe('#CC785C')
  })

  it('falls back when the preset is empty', () => {
    expect(accentFor({ presetColor: '', command: 'claude' })).toBe(harnessAccent('claude'))
    expect(accentFor({ presetColor: '   ', command: 'claude' })).toBe(harnessAccent('claude'))
    expect(accentFor({ command: 'claude' })).toBe(harnessAccent('claude'))
  })

  it('falls back when the preset is not a hex colour', () => {
    expect(accentFor({ presetColor: 'blue', command: 'grok' })).toBe(harnessAccent('grok'))
    expect(accentFor({ presetColor: '#3b82f', command: 'grok' })).toBe(harnessAccent('grok'))
    expect(accentFor({ presetColor: '#3b82f6ff', command: 'grok' })).toBe(harnessAccent('grok'))
    expect(accentFor({ presetColor: '3b82f6', command: 'grok' })).toBe(harnessAccent('grok'))
  })

  it('prefers harnessId over command for the fallback', () => {
    expect(accentFor({ harnessId: 'claude-code', command: 'grok' })).toBe(
      harnessAccent('claude-code'),
    )
  })

  it('uses the harness palette for claude, grok, and everything else', () => {
    expect(accentFor({ command: 'claude' })).toBe('#CC785C')
    expect(accentFor({ harnessId: 'grok-build' })).toBe('#9ca3af')
    expect(accentFor({})).toBe('#34d399')
    expect(accentFor({ command: 'hermes' })).toBe('#34d399')
  })

  it('aligns rail and conversation colour for a node-default preset', () => {
    const preset = { color: '', model: '' }
    const rail = accentFor({ presetColor: preset.color, command: preset.model })
    // Plane may claim the session as claude-code; that harnessId is not passed.
    const conversation = accentFor({
      presetColor: preset.color,
      command: preset.model || undefined,
    })
    expect(conversation).toBe(rail)
    expect(rail).toBe(harnessAccent())
    expect(
      accentFor({
        presetColor: preset.color,
        harnessId: 'claude-code',
        command: preset.model,
      }),
    ).not.toBe(rail)
  })
})
