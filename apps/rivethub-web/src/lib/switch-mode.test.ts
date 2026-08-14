import { describe, it, expect, vi } from 'vitest'
import {
  isTauriShell,
  nodeSwitchMode,
  performNodeSwitch,
  resolveNodeSwitch,
} from './switch-mode.js'

describe('switch-mode', () => {
  it('browser (no __TAURI__) always resolves as repoint', () => {
    const g = {}
    expect(isTauriShell(g)).toBe(false)
    expect(nodeSwitchMode()).toBe('repoint')
    // 192.168.1.x — documentation-safe; CI blocks real lab 10.x ranges
    const r = resolveNodeSwitch('http://192.168.1.5:5174/')
    expect(r).toEqual({ mode: 'repoint', url: 'http://192.168.1.5:5174' })
  })

  it('canonicalizes path away (den path is not a hub origin)', () => {
    expect(resolveNodeSwitch('http://192.168.1.5:5174/den/')).toBeNull()
    expect(resolveNodeSwitch('http://192.168.1.5:5174?x=1')).toBeNull()
  })

  it('Tauri shell also re-points (same mode as browser)', () => {
    const g = { __TAURI__: {} }
    expect(isTauriShell(g)).toBe(true)
    expect(nodeSwitchMode()).toBe('repoint')
    const r = resolveNodeSwitch('http://192.168.1.9:5174')
    expect(r).toEqual({ mode: 'repoint', url: 'http://192.168.1.9:5174' })
  })

  it('performNodeSwitch always re-points via switchTo', () => {
    const switchTo = vi.fn()
    const r = performNodeSwitch('http://192.168.1.5:5174/', switchTo)
    expect(r?.mode).toBe('repoint')
    expect(switchTo).toHaveBeenCalledWith('http://192.168.1.5:5174')
  })

  it('same-origin peer still re-points (no special same-origin no-op)', () => {
    const switchTo = vi.fn()
    const r = performNodeSwitch('http://192.168.1.5:5174', switchTo)
    expect(r?.mode).toBe('repoint')
    expect(switchTo).toHaveBeenCalledWith('http://192.168.1.5:5174')
  })

  it('rejects non-http(s) schemes and userinfo (no switchTo)', () => {
    const switchTo = vi.fn()
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'ftp://192.168.1.5/',
      'http://127.0.0.1:5174@evil.com',
      'http://user:pass@192.168.1.5:5174',
      '',
      '   ',
      'not-a-url',
    ]) {
      expect(resolveNodeSwitch(bad)).toBeNull()
      expect(performNodeSwitch(bad, switchTo)).toBeNull()
    }
    expect(switchTo).not.toHaveBeenCalled()
  })
})
