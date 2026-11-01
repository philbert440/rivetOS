/**
 * Where `rivetos migrate-to-rivethub` gets the RivetHub binaries.
 *
 * RIVETHUB_RELEASE is the single place that knows the release layout of
 * philbert440/rivethub-runtime: every tag `v<version>` publishes one
 * `rh-<version>-<target>.tar.gz` per platform, each holding `rh`,
 * `rivethub-migrate` and `LICENSE` at its top level, plus one `SHA256SUMS`
 * covering the archives. Published archives are never replaced. If the
 * layout changes, change it here and nowhere else. `--binary <path>`
 * bypasses all of this.
 */

import { createHash } from 'node:crypto'
import { extractTarGz } from '../../lib/mesh-enroll.js'

export const RIVETHUB_RELEASE = {
  /** GitHub `owner/repo` that publishes the releases. */
  repo: 'philbert440/rivethub-runtime',
  /** The executables each archive carries at its top level. */
  binaries: { rh: 'rh', migrate: 'rivethub-migrate' },
  /** One `sha256sum`-format file per release, listing every archive. */
  checksums: 'SHA256SUMS',
  /** The archive's Rust target for each Linux `process.arch` a release ships. */
  linuxTargets: {
    x64: 'x86_64-unknown-linux-gnu',
    arm64: 'aarch64-unknown-linux-gnu',
  } as Readonly<Record<string, string>>,
} as const

export type BinaryName = keyof typeof RIVETHUB_RELEASE.binaries

/** Upper bounds for unpacking an archive (rh is tens of MB uncompressed). */
const MAX_ARCHIVE_DECODED_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_MEMBER_BYTES = 256 * 1024 * 1024

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/

/** The archive target for this host, or undefined when no release ships one. */
export function releaseTarget(platform: string, arch: string): string | undefined {
  return platform === 'linux' ? RIVETHUB_RELEASE.linuxTargets[arch] : undefined
}

/** True when the running host can use the published release archives. */
export function releaseSupportsHost(platform: string, arch: string): boolean {
  return releaseTarget(platform, arch) !== undefined
}

/** `rh-<version>-<target>.tar.gz`, the version being the tag without its `v`. */
export function releaseArchive(tag: string, target: string): string {
  return `rh-${tag.replace(/^v/, '')}-${target}.tar.gz`
}

/** Download URL for one asset of a release tag. */
export function releaseAssetUrl(asset: string, tag: string): string {
  return `https://github.com/${RIVETHUB_RELEASE.repo}/releases/download/${tag}/${asset}`
}

/** GitHub API endpoint listing the published releases, prereleases included. */
export function releasesApiUrl(): string {
  return `https://api.github.com/repos/${RIVETHUB_RELEASE.repo}/releases?per_page=100`
}

/**
 * The highest `vX.Y.Z` among the published releases in a GitHub release
 * list, prereleases included (what `rh update --channel beta` installs).
 */
export function newestReleaseTag(text: string): string | undefined {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  let best: { tag: string; parts: number[] } | undefined
  for (const entry of list as { tag_name?: unknown; draft?: unknown }[]) {
    if (entry.draft === true || typeof entry.tag_name !== 'string') continue
    const m = RELEASE_TAG.exec(entry.tag_name)
    if (!m) continue
    const parts = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (!best || compareVersions(parts, best.parts) > 0) best = { tag: entry.tag_name, parts }
  }
  return best?.tag
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The SHA-256 that a `SHA256SUMS` file lists for one file name. */
export function checksumFor(sums: string, file: string): string | undefined {
  for (const line of sums.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 2) continue
    const [digest, name] = fields as [string, string]
    if (name.replace(/^\*/, '') === file && /^[0-9a-f]{64}$/i.test(digest)) {
      return digest.toLowerCase()
    }
  }
  return undefined
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `rh` and `rivethub-migrate` from a release archive; throws when either is missing. */
export function unpackBinaries(archive: string, bytes: Uint8Array): Record<BinaryName, Buffer> {
  let files: Map<string, Buffer>
  try {
    files = extractTarGz(Buffer.from(bytes), {
      maxDecodedBytes: MAX_ARCHIVE_DECODED_BYTES,
      maxMemberBytes: MAX_ARCHIVE_MEMBER_BYTES,
    })
  } catch (err) {
    throw new Error(`${archive} could not be unpacked: ${(err as Error).message}`, { cause: err })
  }
  const pick = (name: string): Buffer => {
    const data = files.get(name)
    if (!data) throw new Error(`${archive} does not contain ${name}`)
    return data
  }
  return {
    rh: pick(RIVETHUB_RELEASE.binaries.rh),
    migrate: pick(RIVETHUB_RELEASE.binaries.migrate),
  }
}
