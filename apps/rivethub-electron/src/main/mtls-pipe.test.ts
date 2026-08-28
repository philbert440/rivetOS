// Ported from the Tauri shell's proxy.rs tests — same cases, same semantics,
// so the Node pipe cannot silently drift from the behavior the fleet already
// trusts.
import { describe, expect, it } from 'vitest'
import { hostAllowed, ListenerSet, MAX_LISTENERS, parseTarget } from './mtls-pipe.js'

describe('hostAllowed', () => {
  it('allows LAN, mesh and loopback hosts only', () => {
    expect(hostAllowed('192.168.1.10')).toBe(true)
    expect(hostAllowed('10.0.0.5')).toBe(true)
    expect(hostAllowed('172.16.9.9')).toBe(true) // generic RFC1918 example, not a host — secret-scan-allow
    expect(hostAllowed('127.0.0.1')).toBe(true)
    expect(hostAllowed('100.64.0.7')).toBe(true) // CGNAT (WG overlay)
    expect(hostAllowed('fd00::7')).toBe(true) // v6 ULA (WG overlay) — generic RFC4193 example, secret-scan-allow
    expect(hostAllowed('ct112.mesh')).toBe(true)
    expect(hostAllowed('localhost')).toBe(true)
    expect(hostAllowed('8.8.8.8')).toBe(false)
    expect(hostAllowed('100.128.0.1')).toBe(false) // past CGNAT /10
    expect(hostAllowed('2001:db8::1')).toBe(false)
    expect(hostAllowed('example.com')).toBe(false)
    expect(hostAllowed('::ffff:8.8.8.8')).toBe(false) // mapped v4 is not ULA
  })
})

describe('parseTarget', () => {
  it('parses gateway bases', () => {
    expect(() => parseTarget('https://192.0.2.7:5174')).toThrow(/refusing to proxy/)
    expect(parseTarget('https://10.0.0.7:5174')).toEqual({ host: '10.0.0.7', port: 5174 })
    expect(parseTarget('https://ct112.mesh:5174/')).toEqual({ host: 'ct112.mesh', port: 5174 })
    expect(parseTarget('https://ct112.mesh')).toEqual({ host: 'ct112.mesh', port: 5174 })
    expect(() => parseTarget('http://10.0.0.7:5174')).toThrow(/not an https url/)
    expect(() => parseTarget('https://10.0.0.7:5174/den')).toThrow(/must not carry a path/)
    // bracketed v6 — ULA overlay with explicit port (generic RFC4193 examples, secret-scan-allow)
    expect(parseTarget('https://[fd00::7]:5174')).toEqual({ host: 'fd00::7', port: 5174 }) // secret-scan-allow
    expect(parseTarget('https://[fd00::7]')).toEqual({ host: 'fd00::7', port: 5174 }) // secret-scan-allow
    expect(() => parseTarget('https://[2001:db8::1]:5174')).toThrow(/refusing to proxy/) // public v6 refused
    expect(() => parseTarget('https://[fd00::7')).toThrow(/unclosed v6 bracket/) // secret-scan-allow
    expect(() => parseTarget('https://10.0.0.7:port')).toThrow(/bad port/)
    expect(() => parseTarget('https://')).toThrow(/empty host/)
  })
})

describe('ListenerSet', () => {
  it('evicts the stalest past the cap', () => {
    const set = new ListenerSet<number>()
    const evicted: string[] = []
    for (let i = 0; i < MAX_LISTENERS; i++) {
      set.insert(`https://10.0.0.${i}:5174`, i, (t) => evicted.push(t))
    }
    expect(evicted).toEqual([]) // at cap, nothing evicted yet
    // One past the cap evicts the stalest (no activity: first-inserted) and
    // only that one.
    set.insert('https://ct112.mesh:5174', 9999, (t) => evicted.push(t))
    expect(evicted).toEqual(['https://10.0.0.0:5174'])
    expect(set.get('https://10.0.0.0:5174')).toBeUndefined()
    expect(set.get('https://10.0.0.7:5174')).toBe(7)
    expect(set.get('https://ct112.mesh:5174')).toBe(9999)
  })

  it('get refreshes recency', () => {
    const set = new ListenerSet<number>()
    const evicted: string[] = []
    for (let i = 0; i < MAX_LISTENERS; i++) {
      set.insert(`https://10.0.0.${i}:5174`, i, (t) => evicted.push(t))
    }
    // Re-asking for the first-inserted entry (a window re-resolving its port)
    // makes it most-recent: the SECOND-oldest is evicted instead.
    expect(set.get('https://10.0.0.0:5174')).toBe(0)
    set.insert('https://ct112.mesh:5174', 9999, (t) => evicted.push(t))
    expect(evicted).toEqual(['https://10.0.0.1:5174'])
    expect(set.get('https://10.0.0.0:5174')).toBe(0)
  })

  it('touch keeps the active listener', () => {
    // The live-pipe scenario: one active gateway (touched on every accepted
    // connection) plus a picker's worth of one-shot name probes. Past the cap
    // the stalest PROBE is evicted — never the listener carrying traffic.
    const set = new ListenerSet<number>()
    const evicted: string[] = []
    set.insert('https://10.0.0.1:5174', 1, (t) => evicted.push(t))
    for (let i = 0; i < MAX_LISTENERS - 1; i++) {
      set.insert(`https://10.0.1.${i}:5174`, i, (t) => evicted.push(t))
    }
    set.touch('https://10.0.0.1:5174')
    set.insert('https://ct112.mesh:5174', 9999, (t) => evicted.push(t))
    expect(evicted).toEqual(['https://10.0.1.0:5174']) // generic RFC1918 example, secret-scan-allow
    expect(set.get('https://10.0.0.1:5174')).toBe(1)
    // Touching an evicted/unknown key is a no-op (a connection accepted just
    // before its listener's close).
    set.touch('https://10.0.1.0:5174') // secret-scan-allow
    expect(evicted).toEqual(['https://10.0.1.0:5174']) // secret-scan-allow
  })

  it('values snapshots without perturbing recency', () => {
    const set = new ListenerSet<number>()
    const evicted: string[] = []
    set.insert('https://10.0.0.1:5174', 1, (t) => evicted.push(t))
    set.insert('https://10.0.0.2:5174', 2, (t) => evicted.push(t))
    expect(set.values()).toEqual([1, 2])
    expect(set.values()).toEqual([1, 2]) // second read unchanged
  })
})
