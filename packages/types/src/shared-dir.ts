/**
 * Shared-storage root for RivetOS.
 *
 * Homelab deployments mount NFS at `/rivet-shared`. Distributions honor
 * `RIVETOS_SHARED_DIR` so the path is not hardcoded. Unset/empty keeps the
 * historical default — zero behavior change for existing installs.
 */

import { join } from 'node:path'

const DEFAULT_SHARED_DIR = '/rivet-shared'

/**
 * Resolve the shared-storage directory.
 *
 * Reads `RIVETOS_SHARED_DIR` at call time (trimmed; empty/whitespace falls
 * through). Default: `/rivet-shared`.
 */
export function sharedDir(): string {
  const raw = process.env.RIVETOS_SHARED_DIR?.trim()
  return raw ? raw : DEFAULT_SHARED_DIR
}

/** Join path segments onto {@link sharedDir}. */
export function sharedPath(...segments: string[]): string {
  return join(sharedDir(), ...segments)
}
