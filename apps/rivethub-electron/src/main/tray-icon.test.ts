import { describe, expect, it } from 'vitest'
import { parseForeground, tintBitmap } from './tray-icon.js'

describe('parseForeground', () => {
  it('reads the theme foreground', () => {
    expect(parseForeground('mode = "dark"\nforeground = "#D4BE98"\n')).toBe('#d4be98')
  })

  it('ignores the dark_/light_/bright_ variants', () => {
    expect(parseForeground('dark_foreground = "#7c6f64"\nforeground = "#d4be98"')).toBe('#d4be98')
    expect(parseForeground('bright_foreground = "#ffffff"')).toBeUndefined()
  })

  it('rejects anything but a 6-digit hex', () => {
    expect(parseForeground('foreground = "white"')).toBeUndefined()
    expect(parseForeground('')).toBeUndefined()
  })
})

describe('tintBitmap', () => {
  // BGRA pixels: opaque white, half-covered edge, transparent.
  it('repaints premultiplied masks and keeps alpha', () => {
    const mask = Buffer.from([255, 255, 255, 255, 128, 128, 128, 128, 0, 0, 0, 0])
    expect([...tintBitmap(mask, '#ff8000')]).toEqual([0, 128, 255, 255, 0, 64, 128, 128, 0, 0, 0, 0])
  })

  it('repaints straight-alpha masks without scaling color', () => {
    const mask = Buffer.from([255, 255, 255, 255, 255, 255, 255, 128])
    expect([...tintBitmap(mask, '#ff8000')]).toEqual([0, 128, 255, 255, 0, 128, 255, 128])
  })
})
