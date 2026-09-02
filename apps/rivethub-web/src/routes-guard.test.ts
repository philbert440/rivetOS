import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('routes source guard', () => {
  it('redirects /index.html to / so Electron shells < 0.5.11 reach chat', () => {
    const src = readFileSync(new URL('./routes.tsx', import.meta.url), 'utf8')
    expect(src).toContain("path: '/index.html'")
    expect(src).toContain("redirect({ to: '/'")
    const pathIdx = src.indexOf("path: '/index.html'")
    expect(pathIdx).toBeGreaterThan(-1)
    const prefix = src.slice(0, pathIdx)
    const createIdx = prefix.lastIndexOf('createRoute(')
    expect(createIdx).toBeGreaterThan(-1)
    const decl = prefix.slice(0, createIdx).match(/const (\w+) = $/)
    expect(decl?.[1]).toBe('indexHtmlRoute')
    const childrenStart = src.indexOf('addChildren([')
    expect(childrenStart).toBeGreaterThan(-1)
    expect(src.slice(childrenStart)).toContain(decl![1])
  })
})
