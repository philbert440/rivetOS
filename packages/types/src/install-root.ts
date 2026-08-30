/**
 * Runtime install root for RivetOS.
 *
 * Homelab deployments live at `/opt/rivetos`. Distributions honor
 * `RIVETOS_INSTALL_ROOT` so the path is not hardcoded. Unset/empty keeps the
 * historical default — zero behavior change for existing installs.
 */

import { join } from 'node:path'

const DEFAULT_INSTALL_ROOT = '/opt/rivetos'

/**
 * Resolve the runtime install directory.
 *
 * Reads `RIVETOS_INSTALL_ROOT` at call time (trimmed; empty/whitespace falls
 * through). Default: `/opt/rivetos`.
 */
export function installRoot(): string {
  const raw = process.env.RIVETOS_INSTALL_ROOT?.trim()
  return raw ? raw : DEFAULT_INSTALL_ROOT
}

/** Join path segments onto {@link installRoot}. */
export function installPath(...segments: string[]): string {
  return join(installRoot(), ...segments)
}
