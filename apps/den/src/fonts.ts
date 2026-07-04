// Pack font loading — register the manifest's FontFace entries and hand out
// a font stack per text role. Fonts are cosmetic: a missing or slow font file
// must never block boot, so every failure falls back to Courier and moves on.

import type { FontRole } from '@rivetos/den-packs'
import type { LoadedPack } from './pack.js'

const FALLBACK = '"Courier New", monospace'

export interface FontMap {
  fontFor(role: FontRole): string
}

export async function loadPackFonts(pack: LoadedPack): Promise<FontMap> {
  // first loaded font wins a role; later duplicates keep their other roles
  const byRole: Partial<Record<FontRole, string>> = {}
  for (const spec of pack.manifest.fonts ?? []) {
    try {
      const face = new FontFace(spec.family, `url("${pack.url(spec.src)}")`)
      await Promise.race([
        face.load(),
        // cap the wait — a hung fetch would otherwise stall boot indefinitely
        new Promise((_, reject) => setTimeout(reject, 3000, new Error('timed out after 3s'))),
      ])
      document.fonts.add(face)
      for (const role of spec.roles) byRole[role] ??= spec.family
    } catch (err) {
      console.warn('[den] font failed to load', spec.family, err)
    }
  }
  return {
    fontFor: (role) => (byRole[role] ? `"${byRole[role]}", ${FALLBACK}` : FALLBACK),
  }
}
