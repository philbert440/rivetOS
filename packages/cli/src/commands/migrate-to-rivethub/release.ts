/**
 * Where `rivetos migrate-to-rivethub` gets the RivetHub binaries.
 *
 * RIVETHUB_RELEASE is the single place that knows the release layout. The
 * release pipeline for philbert440/rivethub-runtime is new: if the asset
 * names, the checksum naming or the host change, change them here and
 * nowhere else. `--binary <path>` bypasses all of this.
 */

import { createHash } from 'node:crypto'

export const RIVETHUB_RELEASE = {
  /** GitHub `owner/repo` that publishes the release assets. */
  repo: 'philbert440/rivethub-runtime',
  /** Asset names for linux x86_64. */
  assets: { rh: 'rh', migrate: 'rivethub-migrate' },
  /**
   * Checksum asset for an asset: `<asset>.sha256`, holding the hex digest,
   * optionally followed by the file name (`sha256sum` output).
   */
  checksumAsset: (asset: string): string => `${asset}.sha256`,
  /** Only platform the release ships today. */
  platform: 'linux',
  arch: 'x64',
} as const

export type BinaryName = keyof typeof RIVETHUB_RELEASE.assets

/** Download URL for one asset; no tag means the latest release. */
export function releaseAssetUrl(asset: string, tag?: string): string {
  const base = `https://github.com/${RIVETHUB_RELEASE.repo}/releases`
  return tag ? `${base}/download/${tag}/${asset}` : `${base}/latest/download/${asset}`
}

/** GitHub API endpoint naming the latest release. */
export function latestReleaseApiUrl(): string {
  return `https://api.github.com/repos/${RIVETHUB_RELEASE.repo}/releases/latest`
}

/** `tag_name` of a GitHub release JSON document, when it is a safe tag. */
export function parseReleaseTag(text: string): string | undefined {
  try {
    const tag = (JSON.parse(text) as { tag_name?: unknown }).tag_name
    return typeof tag === 'string' && /^[\w.\-]+$/.test(tag) ? tag : undefined
  } catch {
    return undefined
  }
}

/** First token of a checksum file, validated as a SHA-256 hex digest. */
export function parseChecksum(text: string): string | undefined {
  const token = text.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return /^[0-9a-f]{64}$/.test(token) ? token : undefined
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** True when the running host can use the published release assets. */
export function releaseSupportsHost(platform: string, arch: string): boolean {
  return platform === RIVETHUB_RELEASE.platform && arch === RIVETHUB_RELEASE.arch
}
