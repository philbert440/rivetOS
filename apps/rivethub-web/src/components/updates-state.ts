/**
 * Pure state logic for the Settings → Updates surface, kept free of React and
 * any browser-coupled imports so it is unit-testable in a node test env.
 */

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string; sizeBytes?: number; notice?: string }
  | { kind: 'installing' }
  | { kind: 'error'; message: string }

/** Shown when main skips an in-app install because the dir is package-managed. */
export const PACKAGE_MANAGED_NOTICE =
  'managed by your package manager — update with your package manager'

/**
 * Map the install IPC result onto renderer state.
 * `false` is a clean skip (leave installing; restore available + notice).
 * `true` keeps installing — a real install still quits.
 * `undefined` (older shells) is treated as success, not a skip.
 */
export function stateAfterInstallResult(
  installed: boolean | undefined,
  available: { version: string; sizeBytes?: number },
): UpdateState {
  if (installed === false) {
    return {
      kind: 'available',
      version: available.version,
      sizeBytes: available.sizeBytes,
      notice: PACKAGE_MANAGED_NOTICE,
    }
  }
  return { kind: 'installing' }
}
