import { describe, expect, it } from 'vitest'
import { nodeLabel, themeLabel } from './sidebar-chrome.js'

describe('themeLabel', () => {
  it('names the Omarchy theme when one drives the palette', () => {
    expect(themeLabel('omarchy', 'Gruvbox')).toBe('Gruvbox')
    expect(themeLabel('omarchy', undefined)).toBe('omarchy')
  })

  it('shows the preference otherwise', () => {
    expect(themeLabel('dark', 'Gruvbox')).toBe('dark')
    expect(themeLabel('system', undefined)).toBe('system')
  })
})

describe('nodeLabel', () => {
  const roster = [{ name: 'den-01', baseUrl: 'https://den-01:5174' }]

  it('uses the roster name for the active endpoint', () => {
    expect(nodeLabel('https://den-01:5174', roster)).toBe('den-01')
  })

  it('falls back to the host, then to "no node"', () => {
    expect(nodeLabel('https://other:5174', roster)).toBe('other:5174')
    expect(nodeLabel('', roster)).toBe('no node')
  })
})
