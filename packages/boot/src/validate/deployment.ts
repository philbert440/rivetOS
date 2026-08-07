/**
 * Deployment section validator — validates the optional deployment config.
 * Only `deployment.target` is known/read; any other key under `deployment`
 * warns (same unknown-key convention as other sections).
 */

import { KNOWN_DEPLOYMENT_KEYS, VALID_DEPLOYMENT_TARGETS, type ValidationIssue } from './types.js'

/**
 * Validate the deployment section of the config.
 */
export function validateDeployment(
  deployment: Record<string, unknown>,
  issues: ValidationIssue[],
): void {
  // Check for unknown keys (datahub/image/docker/proxmox/kubernetes used to be
  // known write-only keys — they now warn so stale configs surface clearly).
  for (const key of Object.keys(deployment)) {
    if (!KNOWN_DEPLOYMENT_KEYS.has(key)) {
      issues.push({
        severity: 'warning',
        path: `deployment.${key}`,
        message: `Unknown deployment key "${key}"`,
      })
    }
  }

  // target (required)
  if (!deployment.target) {
    issues.push({
      severity: 'error',
      path: 'deployment.target',
      message:
        'Missing required field "deployment.target" — must be one of: docker, proxmox, kubernetes, manual',
    })
  } else if (
    typeof deployment.target !== 'string' ||
    !VALID_DEPLOYMENT_TARGETS.has(deployment.target)
  ) {
    issues.push({
      severity: 'error',
      path: 'deployment.target',
      message: `Invalid deployment target "${deployment.target as string}" — must be one of: ${[...VALID_DEPLOYMENT_TARGETS].join(', ')}`,
    })
  }
}
