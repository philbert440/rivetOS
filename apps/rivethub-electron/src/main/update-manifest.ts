/**
 * Pure manifest/version logic for in-app updates (electron-free, unit-
 * tested). MAIN is the trust root: the renderer never supplies a URL or a
 * digest — it names a gateway base it is connected to, and main fetches
 * `builds/rivethub/latest.json` through its own mTLS pipe, validates the
 * entry with these functions, and builds the download URL itself.
 *
 * Trust decision (explicit, per review): the manifest lives on the mesh
 * filestore (/rivet-shared). Anyone with write access to that share can feed
 * every hub an installer — on this private mesh, /rivet-shared write access
 * is already equivalent to owning the fleet (runbooks, bin/, node state).
 * Publisher signatures over the manifest are the follow-up that would close
 * filestore tampering; until then integrity (sha256 from the manifest main
 * fetched) is what this verifies, not publisher authenticity.
 */

export interface ManifestEntry {
  version: string
  file: string
  sha256: string
  sizeBytes?: number
}

export const MANIFEST_PATH = 'builds/rivethub/latest.json'
export const BUILDS_PREFIX = 'builds/rivethub'

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256_RE = /^[0-9a-f]{64}$/
/** Artifact basename fence: no separators, no dot-prefix, no traversal. The
 *  files API decodes %2F and friends — the fence must reject them here. */
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/** Validate one platform's manifest entry; throws with a reason. */
export function validateManifestEntry(raw: unknown, platform: string): ManifestEntry {
  const e = raw as Partial<ManifestEntry> | null | undefined
  if (!e || typeof e !== 'object') throw new Error(`manifest has no entry for ${platform}`)
  if (typeof e.version !== 'string' || !VERSION_RE.test(e.version))
    throw new Error(`manifest ${platform}: version is not semver`)
  if (typeof e.file !== 'string' || !FILE_RE.test(e.file) || e.file.includes('..'))
    throw new Error(`manifest ${platform}: file is not a plain basename`)
  if (typeof e.sha256 !== 'string' || !SHA256_RE.test(e.sha256))
    throw new Error(`manifest ${platform}: sha256 is not a hex digest`)
  const sizeBytes =
    typeof e.sizeBytes === 'number' && Number.isInteger(e.sizeBytes) && e.sizeBytes > 0
      ? e.sizeBytes
      : undefined
  return { version: e.version, file: e.file, sha256: e.sha256, sizeBytes }
}

/**
 * Semver compare: newer(a, b) — true when a > b. Numeric triple first;
 * a release outranks any prerelease of the same triple; two prereleases
 * compare by identifier per semver §11 (numeric < alphanumeric). Build
 * metadata is ignored. Non-semver input = never newer (fail closed).
 */
export function newerVersion(a: string, b: string): boolean {
  if (!VERSION_RE.test(a) || !VERSION_RE.test(b)) return false
  const parse = (v: string): { nums: number[]; pre: string[] } => {
    const [core, ...rest] = v.split('+')[0].split('-')
    return {
      nums: core.split('.').map(Number),
      pre: rest.length > 0 ? rest.join('-').split('.') : [],
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i]
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return false
  if (pa.pre.length === 0) return true // release > prerelease
  if (pb.pre.length === 0) return false
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return false // shorter prerelease is lower
    if (y === undefined) return true
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) > Number(y)
    if (xn !== yn) return yn // numeric < alphanumeric
    return x > y
  }
  return false
}
