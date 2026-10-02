/**
 * Operator allow-list for which harnesses this node offers.
 *
 * Unset (`undefined`) = every registered harness is allowed (opt-in; today's
 * behaviour). A configured list stamps `allowed` on `GET /api/harnesses` and
 * refuses new spawn / preset / session-create for ids outside it. Drivers stay
 * registered so existing sessions of a now-disallowed harness still resolve.
 */

import type { HarnessId } from '@rivetos/types'

/**
 * Normalize a config list into a Set of trimmed ids, or `undefined` when the
 * allow-list is not in force (absent / not an array).
 */
export function normalizeAllowedHarnesses(
  list: readonly string[] | undefined | null,
): Set<string> | undefined {
  if (list === undefined || list === null) return undefined
  if (!Array.isArray(list)) return undefined
  const ids: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length > 0) ids.push(trimmed)
  }
  return new Set(ids)
}

/**
 * Probe: is `harnessId` allowed on this node?
 * `undefined` allow-set → always true. Empty set → always false.
 */
export function createAllowedProbe(
  list: readonly string[] | undefined | null,
): (harnessId: HarnessId) => boolean {
  const set = normalizeAllowedHarnesses(list)
  if (set === undefined) return () => true
  return (harnessId) => set.has(harnessId)
}

/** Clear public error for refused launches. */
export function harnessNotAllowedMessage(harnessId: string): string {
  return `harness "${harnessId}" is not allowed on this node (den.allowed_harnesses)`
}
