import { describe, expect, it } from 'vitest'
import type { TermHelloFrame, TermOwnerFrame } from '@rivetos/types'
import { buildClaimFrame, ownerBanner, parseTermControlFrame, reduceOwner, sendClaim } from './owner-banner.js'

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

describe('sendClaim', () => {
  it('sends on an OPEN socket and returns true', () => {
    const sent: string[] = []
    expect(sendClaim({ readyState: 1, send: (d) => sent.push(d) }, 120, 36)).toBe(true)
    expect(sent).toEqual(['{"type":"claim","cols":120,"rows":36}'])
  })

  it('returns false when the socket is missing or not OPEN (no silent send)', () => {
    const sent: string[] = []
    expect(sendClaim(undefined, 80, 24)).toBe(false)
    expect(sendClaim({ readyState: 0, send: (d) => sent.push(d) }, 80, 24)).toBe(false)
    expect(sendClaim({ readyState: 3, send: (d) => sent.push(d) }, 80, 24)).toBe(false)
    expect(sent).toEqual([])
  })
})

describe('parseTermControlFrame', () => {
  it('parses a text hello/owner/exit and ignores other JSON', () => {
    expect(parseTermControlFrame('{"type":"owner","device":"phone","self":false}')).toEqual({
      type: 'owner',
      device: 'phone',
      self: false,
    })
    expect(parseTermControlFrame('{"type":"claim","cols":80,"rows":24}')).toBeUndefined()
  })

  it('parses the same owner frame when delivered as an ArrayBuffer', () => {
    const bytes = new TextEncoder().encode('{"type":"owner","device":"desk","self":true}')
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    expect(parseTermControlFrame(buf)).toEqual({
      type: 'owner',
      device: 'desk',
      self: true,
    })
  })

  it('does not treat PTY bytes as a control frame', () => {
    expect(parseTermControlFrame(new TextEncoder().encode('hello').buffer)).toBeUndefined()
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
