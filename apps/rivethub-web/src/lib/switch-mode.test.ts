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
    expect(nodeSwitchMode(g)).toBe('repoint')
    // 192.168.1.x — documentation-safe; CI blocks real lab 10.x ranges
    const r = resolveNodeSwitch('http://192.168.1.5:5174/', g)
    expect(r).toEqual({ mode: 'repoint', url: 'http://192.168.1.5:5174' })
  })

  it('canonicalizes path away (den path is not a hub origin)', () => {
    expect(resolveNodeSwitch('http://192.168.1.5:5174/den/', {})).toBeNull()
    expect(resolveNodeSwitch('http://192.168.1.5:5174?x=1', {})).toBeNull()
  })

  it('Tauri shell also re-points (same mode as browser)', () => {
    const g = { __TAURI__: {} }
    expect(isTauriShell(g)).toBe(true)
    expect(nodeSwitchMode(g)).toBe('repoint')
    const r = resolveNodeSwitch('http://192.168.1.9:5174', g)
    expect(r).toEqual({ mode: 'repoint', url: 'http://192.168.1.9:5174' })
  })

  it('performNodeSwitch always re-points via switchTo (never navigate)', () => {
    const switchTo = vi.fn()
    const navigate = vi.fn()
    const r = performNodeSwitch('http://192.168.1.5:5174/', switchTo, {
      g: {},
      navigate,
      currentOrigin: 'http://192.168.1.1:5174',
    })
    expect(r?.mode).toBe('repoint')
    expect(switchTo).toHaveBeenCalledWith('http://192.168.1.5:5174')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('same-origin peer still re-points (no special navigate no-op)', () => {
    const switchTo = vi.fn()
    const navigate = vi.fn()
    const r = performNodeSwitch('http://192.168.1.5:5174', switchTo, {
      g: {},
      navigate,
      currentOrigin: 'http://192.168.1.5:5174',
    })
    expect(r?.mode).toBe('repoint')
    expect(switchTo).toHaveBeenCalledWith('http://192.168.1.5:5174')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('performNodeSwitch re-points in Tauri without navigating', () => {
    const switchTo = vi.fn()
    const navigate = vi.fn()
    const r = performNodeSwitch('http://192.168.1.9:5174', switchTo, {
      g: { __TAURI__: {} },
      navigate,
    })
    expect(r?.mode).toBe('repoint')
    expect(switchTo).toHaveBeenCalledWith('http://192.168.1.9:5174')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('rejects non-http(s) schemes and userinfo (no navigate, no switchTo)', () => {
    const switchTo = vi.fn()
    const navigate = vi.fn()
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
      expect(resolveNodeSwitch(bad, {})).toBeNull()
      expect(performNodeSwitch(bad, switchTo, { g: {}, navigate })).toBeNull()
      expect(performNodeSwitch(bad, switchTo, { g: { __TAURI__: {} }, navigate })).toBeNull()
    }
    expect(navigate).not.toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })
})
