// Asset loading: chroma-key the studio background to transparency, trim to
// content, and rasterize everything onto ONE global pixel grid so the whole
// screen reads as drawn at the same resolution. Grid size and chroma color
// come from the active SpritePack (configureAssets), not engine constants.

import { Texture } from 'pixi.js'

// size of one art-pixel in shell units — set from pack.grid.pxPerUnit
export let PX = 4
let chroma = { r: 255, g: 0, b: 255 }
let chromaThreshold = 32
let magentaKey = true

export function configureAssets(opts: {
  pxPerUnit: number
  chromaColor: string
  chromaThreshold: number
}): void {
  PX = opts.pxPerUnit
  chroma = {
    r: parseInt(opts.chromaColor.slice(1, 3), 16),
    g: parseInt(opts.chromaColor.slice(3, 5), 16),
    b: parseInt(opts.chromaColor.slice(5, 7), 16),
  }
  chromaThreshold = opts.chromaThreshold
  // magenta-family keys use the channel-signature metric, which also catches
  // generator drift toward pink and dithered halo pixels
  magentaKey = chroma.r > 180 && chroma.b > 180 && chroma.g < 120
}

export interface KeyedAsset {
  canvas: HTMLCanvasElement // trimmed, keyed source at generation resolution
  ox: number
  oy: number // trim offset in original image
  bw: number
  bh: number // trimmed content size (source px)
  iw: number
  ih: number // original image size
}

// how strongly a pixel matches the key color; > threshold gets keyed out
function keyness(r: number, g: number, b: number): number {
  if (magentaKey) return Math.min(r, b) - g
  return (
    chromaThreshold * 2 -
    Math.max(Math.abs(r - chroma.r), Math.abs(g - chroma.g), Math.abs(b - chroma.b))
  )
}

export async function loadAsset(url: string, key = true): Promise<KeyedAsset> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0)

  if (!key) return { canvas: c, ox: 0, oy: 0, bw: c.width, bh: c.height, iw: c.width, ih: c.height }

  const id = ctx.getImageData(0, 0, c.width, c.height)
  const d = id.data
  let minX = c.width,
    minY = c.height,
    maxX = 0,
    maxY = 0
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4
      if (keyness(d[i], d[i + 1], d[i + 2]) > chromaThreshold) {
        d[i + 3] = 0
      } else {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  ctx.putImageData(id, 0, 0)
  const bw = maxX - minX + 1,
    bh = maxY - minY + 1
  const t = document.createElement('canvas')
  t.width = bw
  t.height = bh
  t.getContext('2d')!.drawImage(c, minX, minY, bw, bh, 0, 0, bw, bh)
  return { canvas: t, ox: minX, oy: minY, bw, bh, iw: c.width, ih: c.height }
}

// Resample an asset so it displays at targetH shell-pixels tall with art-pixels
// exactly PX shell-pixels big. Returns a low-res texture; draw it scaled by PX.
export function pixelTexture(
  asset: KeyedAsset,
  targetH: number,
): { texture: Texture; cols: number; rows: number } {
  const rows = Math.max(1, Math.round(targetH / PX))
  const cols = Math.max(1, Math.round((asset.bw * (targetH / asset.bh)) / PX))
  const small = document.createElement('canvas')
  small.width = cols
  small.height = rows
  const sctx = small.getContext('2d')!
  sctx.imageSmoothingEnabled = true
  sctx.imageSmoothingQuality = 'high'
  sctx.drawImage(asset.canvas, 0, 0, cols, rows)
  // harden alpha so downscale-blended edges stay crisp pixels, not fringe
  const id = sctx.getImageData(0, 0, cols, rows)
  for (let i = 3; i < id.data.length; i += 4) id.data[i] = id.data[i] > 110 ? 255 : 0
  sctx.putImageData(id, 0, 0)
  const texture = Texture.from(small)
  texture.source.scaleMode = 'nearest'
  return { texture, cols, rows }
}
