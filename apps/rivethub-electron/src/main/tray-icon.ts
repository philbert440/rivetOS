/**
 * Theme-colored tray icon. The tray sits in the desktop's top bar, whose
 * background follows the Omarchy theme — light or dark — so no single baked
 * color reads on every theme. The tray instead ships a white `rh` mask
 * (icons/tray-mask.png) and paints it in the theme's `foreground`, the color
 * the bar's own text uses. Re-run on every theme switch (omarchy-watch).
 *
 * Pure helpers here; index.ts owns the nativeImage / Tray side.
 */

const HEX6 = /^#[0-9a-fA-F]{6}$/

/** `foreground = "#rrggbb"` from an Omarchy colors.toml, else undefined. */
export function parseForeground(colorsToml: string): string | undefined {
  const m = /^\s*foreground\s*=\s*["']([^"']+)["']/m.exec(colorsToml)
  const hex = m?.[1]?.trim()
  return hex && HEX6.test(hex) ? hex.toLowerCase() : undefined
}

/**
 * Repaint a BGRA bitmap (nativeImage.toBitmap) in `hex`, keeping each
 * pixel's alpha — the mask's anti-aliased edges survive. Handles both
 * premultiplied and straight alpha: a white mask is premultiplied exactly
 * when no color channel exceeds its alpha.
 */
export function tintBitmap(bgra: Buffer, hex: string): Buffer {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  let premultiplied = true
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3]
    if (bgra[i] > a || bgra[i + 1] > a || bgra[i + 2] > a) {
      premultiplied = false
      break
    }
  }
  const out = Buffer.alloc(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    const a = bgra[i + 3]
    const k = premultiplied ? a / 255 : 1
    out[i] = Math.round(b * k)
    out[i + 1] = Math.round(g * k)
    out[i + 2] = Math.round(r * k)
    out[i + 3] = a
  }
  return out
}
