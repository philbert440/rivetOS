// SpritePack loading — fetch a pack manifest and resolve its sprite URLs.
// The manifest shape is @rivetos/den-packs spec v1 (types only; validation
// happens server-side with `den-pack validate`).

import type { PackManifest, Pose, Station } from '@rivetos/den-packs'
import type { Activity } from '@rivetos/den-protocol'

export interface LoadedPack {
  manifest: PackManifest
  /** Resolve a pack-relative path to a fetchable URL. */
  url: (rel: string) => string
}

export async function loadPack(baseUrl: string): Promise<LoadedPack> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const r = await fetch(`${base}pack.json`)
  if (!r.ok) throw new Error(`pack manifest not found at ${base}pack.json`)
  const manifest = (await r.json()) as PackManifest
  return { manifest, url: (rel: string) => `${base}${rel}` }
}

/** Pose for an activity via the pack fallback chain: tool → activity → idle. */
export function resolvePose(pack: PackManifest, activity: Activity, tool: string | null): string {
  const c = pack.character
  if (tool && c.tools?.[tool] && c.poses[c.tools[tool]]) return c.tools[tool]
  const byActivity = c.activities[activity]
  if (byActivity in c.poses) return byActivity
  return 'idle'
}

export type { PackManifest, Pose, Station }
