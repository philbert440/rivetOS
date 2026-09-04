import { describe, expect, it } from 'vitest'
import type { TermHelloFrame, TermOwnerFrame } from '@rivetos/types'
import { buildClaimFrame, ownerBanner, reduceOwner } from './owner-banner.js'

function hello(owner?: { device: string; self: boolean }): TermHelloFrame {
  return {
    type: 'hello',
    v: 1,
    id: 'p1',
    denSession: 's',
    command: 'claude',
    cols: 80,
    rows: 24,
    state: 'running',
    owner,
  } as TermHelloFrame
}

describe('ownerBanner', () => {
  it('shows for a non-self owner with the device in the label', () => {
    const b = ownerBanner({ device: "Phil's phone", self: false })
    expect(b.show).toBe(true)
    expect(b.label).toBe("This terminal is active on Phil's phone.")
  })

  it('hides when this device owns the terminal', () => {
    expect(ownerBanner({ device: 'this-laptop', self: true }).show).toBe(false)
  })

  it('hides when nobody owns the terminal', () => {
    expect(ownerBanner(undefined).show).toBe(false)
  })
})

describe('buildClaimFrame', () => {
  it('builds a bare claim', () => {
    expect(buildClaimFrame()).toBe('{"type":"claim"}')
  })

  it('carries optional geometry', () => {
    expect(buildClaimFrame(120, 36)).toBe('{"type":"claim","cols":120,"rows":36}')
  })
})

describe('reduceOwner', () => {
  it('adopts the hello owner', () => {
    expect(reduceOwner(undefined, hello({ device: 'phone', self: false }))).toEqual({
      device: 'phone',
      self: false,
    })
  })

  it('clears on a hello without an owner', () => {
    expect(reduceOwner({ device: 'phone', self: false }, hello())).toBeUndefined()
  })

  it('applies an owner broadcast and clears on device null', () => {
    const won: TermOwnerFrame = { type: 'owner', device: 'this-laptop', self: true }
    const lost: TermOwnerFrame = { type: 'owner', device: 'phone', self: false }
    const released: TermOwnerFrame = { type: 'owner', device: null, self: false }
    expect(reduceOwner(undefined, won)).toEqual({ device: 'this-laptop', self: true })
    expect(reduceOwner({ device: 'this-laptop', self: true }, lost)).toEqual({
      device: 'phone',
      self: false,
    })
    expect(reduceOwner({ device: 'phone', self: false }, released)).toBeUndefined()
  })
})
