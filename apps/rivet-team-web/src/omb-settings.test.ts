import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('settings surfaces', () => {
  it('per-bot SettingsPanel is OpenMausBot SettingsPanel', () => {
    const src = readFileSync(join(root, 'src/omb/components/SettingsPanel.tsx'), 'utf8')
    expect(src).toMatch(/export function SettingsPanel/)
    expect(src).toMatch(/Chief of Staff/)
    expect(src.length).toBeGreaterThan(5000)
  })

  it('app SettingsModal is household, not Composio keys', () => {
    const src = readFileSync(join(root, 'src/omb/components/SettingsModal.tsx'), 'utf8')
    expect(src).toMatch(/export function SettingsModal/)
    expect(src).toMatch(/This person/)
    expect(src).toMatch(/Datahub \/ wiki/)
    expect(src).toMatch(/Shared desktop/)
    expect(src).not.toMatch(/ApiKeyRow/)
  })
})
