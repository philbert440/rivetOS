// The composer node picker is a convenience over Settings — switch nodes and
// save mesh-discovered peers. With a single node neither applies, so it hides
// until a second node joins the roster. This scan pins that guard.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./node-picker.tsx', import.meta.url), 'utf8')

describe('composer node picker hides below two nodes', () => {
  it('returns nothing when the roster has one node or fewer', () => {
    expect(source).toContain('if (roster.length <= 1) return')
  })

  it('guards before the render, after the hooks (no conditional hook calls)', () => {
    const guard = source.indexOf('roster.length <= 1')
    const jsxRoot = source.indexOf('<Popover')
    const lastHook = source.lastIndexOf('useNodeName(')
    expect(guard).toBeGreaterThan(lastHook)
    expect(guard).toBeLessThan(jsxRoot)
  })
})
