import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('roster/thread faces are Rivet den-bot', () => {
  it('Avatar.tsx loads den-bot.png and does not import CursorAvatar', () => {
    const src = readFileSync(join(root, 'src/omb/components/Avatar.tsx'), 'utf8')
    expect(src).toMatch(/den-bot\.png/)
    expect(src).not.toMatch(/import .*CursorAvatar/)
    expect(src).not.toMatch(/maus-engine/)
  })

  it('den-bot sprite is in the shipped tree', () => {
    const png = readFileSync(join(root, 'src/omb/assets/den-bot.png'))
    expect(png[0]).toBe(0x89)
    expect(png[1]).toBe(0x50)
    expect(png[2]).toBe(0x4e)
    expect(png[3]).toBe(0x47)
    expect(png.length).toBeGreaterThan(1000)
  })
})
