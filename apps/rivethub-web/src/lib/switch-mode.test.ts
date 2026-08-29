import { describe, it, expect, vi } from 'vitest'
import { performNodeSwitch } from './switch-mode.js'

describe('switch-mode', () => {
  it('re-points via switchTo with the canonical origin', () => {
    const switchTo = vi.fn()
    // 192.168.1.x — documentation-safe; CI blocks real lab 10.x ranges
    const r = performNodeSwitch('http://192.168.1.5:5174/', switchTo)
    expect(r).toBe('http://192.168.1.5:5174')
    expect(switchTo).toHaveBeenCalledWith('http://192.168.1.5:5174')
  })

  it('rejects a path or query (den path is not a hub origin)', () => {
    const switchTo = vi.fn()
    expect(performNodeSwitch('http://192.168.1.5:5174/den/', switchTo)).toBeNull()
    expect(performNodeSwitch('http://192.168.1.5:5174?x=1', switchTo)).toBeNull()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it('same-origin peer still re-points (no special same-origin no-op)', () => {
    const switchTo = vi.fn()
    expect(performNodeSwitch('http://192.168.1.5:5174', switchTo)).toBe('http://192.168.1.5:5174')
    expect(switchTo).toHaveBeenCalledWith('http://192.168.1.5:5174')
  })

  it('rejects non-http(s) schemes and userinfo (no switchTo)', () => {
    const switchTo = vi.fn()
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'http://user:pw@192.168.1.5:5174',
      'ftp://192.168.1.5/',
      'http://127.0.0.1:5174@evil.com',
      '',
      '   ',
      'not-a-url',
    ]) {
      expect(performNodeSwitch(bad, switchTo)).toBeNull()
    }
    expect(switchTo).not.toHaveBeenCalled()
  })
})
