import { describe, expect, it, vi } from 'vitest'

// voice.ts imports the connection store, which touches window/localStorage at
// module init; only pure functions are under test — mock the store away
// (discard-session.test.ts pattern).
vi.mock('../stores/connection.js', () => ({
  isValidGatewayUrl: () => true,
  useConnection: { getState: () => ({ gateway: {} }) },
}))

const { encodeWavPcm16, monoResample, stripForSpeech } = await import('./voice.js')

describe('encodeWavPcm16', () => {
  it('writes a valid mono PCM16 header + clipped samples', () => {
    const samples = new Float32Array([0, 0.5, 1, -1, 2, -2])
    const buf = encodeWavPcm16(samples, 16_000)
    const v = new DataView(buf)
    const tag = (off: number, len: number): string =>
      String.fromCharCode(...new Uint8Array(buf, off, len))
    expect(tag(0, 4)).toBe('RIFF')
    expect(tag(8, 4)).toBe('WAVE')
    expect(tag(36, 4)).toBe('data')
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16_000)
    expect(v.getUint32(40, true)).toBe(samples.length * 2)
    expect(buf.byteLength).toBe(44 + samples.length * 2)
    expect(v.getInt16(44, true)).toBe(0)
    expect(v.getInt16(48, true)).toBe(0x7fff) // 1.0 → max
    expect(v.getInt16(50, true)).toBe(-0x8000) // -1.0 → min
    expect(v.getInt16(52, true)).toBe(0x7fff) // clipped over-range
    expect(v.getInt16(54, true)).toBe(-0x8000) // clipped under-range
  })
})

describe('stripForSpeech', () => {
  it('drops fences, keeps link text, strips list/heading markers', () => {
    const md = [
      '# Result',
      'Use the **fast** path — see [the docs](https://example.invalid/x).',
      '```ts',
      'const x = 1',
      '```',
      '- first item',
      '2. second item',
      '`inline` stays',
    ].join('\n')
    const out = stripForSpeech(md)
    expect(out).not.toContain('const x')
    expect(out).toContain('code block omitted')
    expect(out).toContain('the docs')
    expect(out).not.toContain('https://')
    expect(out).not.toContain('#')
    expect(out).not.toContain('**')
    expect(out).toContain('first item')
    expect(out).toContain('second item')
    expect(out).toContain('inline stays')
  })

  it('collapses whitespace and trims', () => {
    expect(stripForSpeech('  a\n\n\n b  ')).toBe('a b')
  })
})

describe('monoResample', () => {
  const buf = (channels: Float32Array[], sampleRate: number) => ({
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData: (i: number) => channels[i],
  })

  it('empty buffer resolves to zero samples (no src[-1] read)', () => {
    expect(monoResample(buf([], 48_000), 16_000)).toHaveLength(0)
  })

  it('downmixes channels at identity rate', () => {
    const out = monoResample(
      buf([new Float32Array([1, 0.5]), new Float32Array([0, 0.5])], 16_000),
      16_000,
    )
    expect([...out]).toEqual([0.5, 0.5])
  })

  it('downsamples 2:1', () => {
    const out = monoResample(buf([new Float32Array([0, 0.25, 0.5, 0.75])], 32_000), 16_000)
    expect(out).toHaveLength(2)
    expect(out[0]).toBeCloseTo(0, 5)
    expect(out[1]).toBeCloseTo(0.5, 5)
  })

  it('upsamples with linear interpolation between neighbours', () => {
    const out = monoResample(buf([new Float32Array([0, 1])], 8_000), 16_000)
    expect(out).toHaveLength(4)
    expect(out[0]).toBeCloseTo(0, 5)
    expect(out[1]).toBeCloseTo(0.5, 5)
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
