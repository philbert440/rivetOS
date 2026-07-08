import { describe, it, expect } from 'vitest'
import { isTauriShell, nodeSwitchMode, resolveNodeSwitch } from './switch-mode.js'

describe('switch-mode', () => {
  it('browser (no __TAURI__) navigates to peer hub URL', () => {
    const g = {}
    expect(isTauriShell(g)).toBe(false)
    expect(nodeSwitchMode(g)).toBe('navigate')
    const r = resolveNodeSwitch('http://10.4.20.5:5174/', g)
    expect(r).toEqual({ mode: 'navigate', url: 'http://10.4.20.5:5174' })
  })

  it('Tauri shell re-points without requiring full-page navigate', () => {
    const g = { __TAURI__: {} }
    expect(isTauriShell(g)).toBe(true)
    expect(nodeSwitchMode(g)).toBe('repoint')
    const r = resolveNodeSwitch('http://10.4.20.9:5174', g)
    expect(r.mode).toBe('repoint')
    expect(r.url).toBe('http://10.4.20.9:5174')
  })
})
