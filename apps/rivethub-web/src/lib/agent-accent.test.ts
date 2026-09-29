import { describe, expect, it } from 'vitest'
import { accentFor, agentInitials, inkOn, sameLabel } from './agent-accent.js'
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
    expect(accentFor({ harnessId: 'codex' })).toBe('#5b8def')
    expect(accentFor({ command: 'codex' })).toBe('#5b8def')
    expect(accentFor({ harnessId: 'opencode' })).toBe('#2dd4bf')
    expect(accentFor({ command: 'opencode' })).toBe('#2dd4bf')
    expect(accentFor({ harnessId: 'qwen-code' })).toBe('#a78bfa')
    expect(accentFor({ command: 'qwen' })).toBe('#a78bfa')
    expect(accentFor({ command: 'rivet-qwen' })).toBe('#a78bfa')
    expect(accentFor({ harnessId: 'opencode-cli' })).toBe('#2dd4bf')
    expect(accentFor({ command: 'opencode-migration-helper' })).toBe('#34d399')
    expect(accentFor({})).toBe('#34d399')
    expect(accentFor({ command: 'hermes' })).toBe('#e0a340')
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

describe('agentInitials', () => {
  it('takes the first letter of a one-word name', () => {
    expect(agentInitials('reviewer')).toBe('R')
  })

  it('takes the first letters of the first two words', () => {
    expect(agentInitials('grok scout')).toBe('GS')
    expect(agentInitials('claude-code-builder')).toBe('CC')
    expect(agentInitials('my_agent')).toBe('MA')
  })

  it('skips punctuation-only words and leading symbols', () => {
    expect(agentInitials('  — (beta) helper')).toBe('BH')
  })

  it('falls back to ? with no letters', () => {
    expect(agentInitials('')).toBe('?')
    expect(agentInitials('---')).toBe('?')
  })
})

describe('inkOn', () => {
  it('puts dark ink on light fills', () => {
    expect(inkOn('#CC785C')).toBe('#111111')
    expect(inkOn('#9ca3af')).toBe('#111111')
    expect(inkOn('#fff')).toBe('#111111')
  })

  it('puts white ink on dark fills', () => {
    expect(inkOn('#1e3a8a')).toBe('#ffffff')
    expect(inkOn('#000')).toBe('#ffffff')
  })
})

describe('sameLabel', () => {
  it('matches an agent named after its harness', () => {
    expect(sameLabel('Claude Code', 'Claude Code')).toBe(true)
    expect(sameLabel('Grok Build', 'grok Build')).toBe(true)
    expect(sameLabel('qwen_code', 'Qwen Code')).toBe(true)
  })

  it('keeps distinct names apart', () => {
    expect(sameLabel('Nemotron Free', 'opencode')).toBe(false)
    expect(sameLabel('Claude Code 2', 'Claude Code')).toBe(false)
  })
})
