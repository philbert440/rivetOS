import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('shipped shell is OpenMausBot frontend', () => {
  it('keeps their Sidebar / ChatView / Composer / App module names', () => {
    const sidebar = readFileSync(join(root, 'src/omb/components/Sidebar.tsx'), 'utf8')
    const chat = readFileSync(join(root, 'src/omb/components/ChatView.tsx'), 'utf8')
    const composer = readFileSync(join(root, 'src/omb/components/Composer.tsx'), 'utf8')
    const app = readFileSync(join(root, 'src/omb/App.tsx'), 'utf8')
    expect(sidebar).toMatch(/export function Sidebar/)
    expect(sidebar).toMatch(/from "@\/state\/store"/)
    expect(chat).toMatch(/export function ChatView/)
    expect(chat).toMatch(/from "\.\/Composer"/)
    expect(composer).toMatch(/export function Composer/)
    expect(composer).toMatch(/dispatch\(\{ type: "send"/)
    expect(app).toMatch(/from "@\/components\/Sidebar"/)
    expect(app).toMatch(/from "@\/components\/ChatView"/)
  })
})
