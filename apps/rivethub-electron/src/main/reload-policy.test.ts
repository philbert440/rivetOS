import { describe, expect, it } from 'vitest'
import { MAX_RENDERER_RELOADS, RELOAD_HEALTHY_MS, RendererReloadPolicy } from './reload-policy.js'

const T0 = 1_000_000

describe('RendererReloadPolicy', () => {
  it('caps a startup crash loop that never finishes a load', () => {
    const p = new RendererReloadPolicy()
    for (let i = 0; i < MAX_RENDERER_RELOADS; i++) expect(p.shouldReload(T0 + i)).toBe(true)
    expect(p.shouldReload(T0 + 10)).toBe(false)
  })

  it('caps a die-AFTER-load loop — finishing a load does not re-arm by itself', () => {
    const p = new RendererReloadPolicy()
    let now = T0
    for (let i = 0; i < MAX_RENDERER_RELOADS; i++) {
      p.finished(now)
      now += 1_000 // dies 1s after finishing, well inside the healthy window
      expect(p.shouldReload(now)).toBe(true)
    }
    p.finished(now)
    now += 1_000
    expect(p.shouldReload(now)).toBe(false)
    // …and it STAYS stopped while the finish→die cycle stays unhealthy
    p.finished(now)
    expect(p.shouldReload(now + 2_000)).toBe(false)
  })

  it('a load that survives the healthy window resets the streak', () => {
    const p = new RendererReloadPolicy()
    let now = T0
    for (let i = 0; i < MAX_RENDERER_RELOADS; i++) {
      p.finished(now)
      now += 1_000
      p.shouldReload(now)
    }
    // capped now — but the next load stays alive past the window
    p.finished(now)
    now += RELOAD_HEALTHY_MS + 1
    expect(p.shouldReload(now)).toBe(true)
  })

  it('a reload that never finishes cannot inherit the previous finish (stale stamp)', () => {
    // A death consumes the finish stamp: a second death ≥window later with
    // NO new did-finish-load must count against the streak, never reset it
    // off the stale finish.
    const p1 = new RendererReloadPolicy(1, RELOAD_HEALTHY_MS)
    p1.finished(T0)
    expect(p1.shouldReload(T0 + 1_000)).toBe(true)
    expect(p1.shouldReload(T0 + 1_000 + RELOAD_HEALTHY_MS)).toBe(false)
    // Same shape under the default cap: the late death is streak slot #2.
    const p = new RendererReloadPolicy()
    p.finished(T0)
    expect(p.shouldReload(T0 + 1_000)).toBe(true) // slot 1
    expect(p.shouldReload(T0 + 1_000 + RELOAD_HEALTHY_MS)).toBe(true) // slot 2, NOT a reset
    expect(p.shouldReload(T0 + 2_000 + RELOAD_HEALTHY_MS)).toBe(true) // slot 3
    expect(p.shouldReload(T0 + 3_000 + RELOAD_HEALTHY_MS)).toBe(false) // capped — a reset would keep this true
  })

  it('exactly the healthy window counts as survived', () => {
    const p = new RendererReloadPolicy(1, RELOAD_HEALTHY_MS)
    p.finished(T0)
    expect(p.shouldReload(T0 + 1)).toBe(true) // uses the single slot
    p.finished(T0 + 2)
    expect(p.shouldReload(T0 + 2 + RELOAD_HEALTHY_MS)).toBe(true) // boundary resets
  })
})
