// The node switcher is pointless with a single node — there's nowhere to
// switch to. It stays hidden until a second node joins the roster (added
// from Settings). This scan pins that guard in node-switcher.tsx.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./node-switcher.tsx', import.meta.url), 'utf8')

describe('node switcher hides below two nodes', () => {
  it('returns nothing when the roster has one node or fewer', () => {
    expect(source).toContain('if (roster.length <= 1) return')
  })

  it('guards before the render, after the hooks (no conditional hook calls)', () => {
    const guard = source.indexOf('roster.length <= 1')
    const jsxRoot = source.indexOf('<div ref={rootRef}')
    const lastHook = source.lastIndexOf('useNodeName(')
    expect(guard).toBeGreaterThan(lastHook)
    expect(guard).toBeLessThan(jsxRoot)
  })
})
