import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('boot URL', () => {
  it('loads the SPA root, not /index.html', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(src).toContain('loadURL(`${APP_ORIGIN}/`)')
    expect(src).not.toContain('loadURL(`${APP_ORIGIN}/index.html`)')
  })
})
