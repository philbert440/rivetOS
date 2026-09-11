import { describe, expect, it } from 'vitest'
import {
  ACCENT_CLAUDE,
  ACCENT_CODEX,
  ACCENT_FALLBACK,
  ACCENT_GROK,
  ACCENT_HERMES,
  ACCENT_KIMI,
  ACCENT_OPENCODE,
  ACCENT_PI,
  harnessAccent,
} from './harness-colors.js'

const KNOWN_IDS = [
  'claude-code',
  'grok-build',
  'codex',
  'kimi-code',
  'hermes',
  'opencode',
  'pi',
] as const

const EXPECTED: Record<(typeof KNOWN_IDS)[number], string> = {
  'claude-code': ACCENT_CLAUDE,
  'grok-build': ACCENT_GROK,
  codex: ACCENT_CODEX,
  'kimi-code': ACCENT_KIMI,
  hermes: ACCENT_HERMES,
  opencode: ACCENT_OPENCODE,
  pi: ACCENT_PI,
}

describe('harnessAccent', () => {
  it('maps every known harness id to a distinct colour', () => {
    const colors = KNOWN_IDS.map((id) => harnessAccent(id))
    expect(new Set(colors).size).toBe(KNOWN_IDS.length)
    for (const id of KNOWN_IDS) {
      expect(harnessAccent(id)).toBe(EXPECTED[id])
    }
  })

  it('keeps the locked claude / grok / codex hexes', () => {
    expect(harnessAccent('claude-code')).toBe('#CC785C')
    expect(harnessAccent('grok-build')).toBe('#9ca3af')
    expect(harnessAccent('codex')).toBe('#5b8def')
  })

  it('matches roster-command aliases the same as ids', () => {
    expect(harnessAccent('claude')).toBe(ACCENT_CLAUDE)
    expect(harnessAccent('grok')).toBe(ACCENT_GROK)
    expect(harnessAccent('kimi')).toBe(ACCENT_KIMI)
  })

  it('falls back to emerald for unknown ids, including deepseek-harness', () => {
    expect(harnessAccent()).toBe(ACCENT_FALLBACK)
    expect(harnessAccent('unknown-bot')).toBe('#34d399')
    expect(harnessAccent('deepseek-harness')).toBe(ACCENT_FALLBACK)
    expect(KNOWN_IDS.map((id) => harnessAccent(id))).not.toContain(ACCENT_FALLBACK)
  })

  it('does not match short keys inside free-form agent names', () => {
    expect(harnessAccent('gippity')).toBe(ACCENT_FALLBACK)
    expect(harnessAccent('copilot')).toBe(ACCENT_FALLBACK)
    expect(harnessAccent('pixtral')).toBe(ACCENT_FALLBACK)
  })

  it('matches delimited tokens and cli aliases', () => {
    expect(harnessAccent('pi')).toBe(ACCENT_PI)
    expect(harnessAccent('pi-cli')).toBe(ACCENT_PI)
    expect(harnessAccent('opencode')).toBe(ACCENT_OPENCODE)
    expect(harnessAccent('rivet-kimi')).toBe(ACCENT_KIMI)
  })

  it('falls back to emerald for inherited object property names', () => {
    expect(harnessAccent('constructor')).toBe(ACCENT_FALLBACK)
    expect(harnessAccent('__proto__')).toBe(ACCENT_FALLBACK)
  })
})
