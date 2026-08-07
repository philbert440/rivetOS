/**
 * Phase 2: Deployment target selection.
 *
 * Nested deployment keys (datahub/image/docker/proxmox/kubernetes) are no
 * longer written to config — only `target` is. Proxmox node/API prompts were
 * removed because they populated only those deleted keys. Env-file generation
 * for docker/proxmox still uses the target (bundled datahub hostname) without
 * needing per-node detail.
 */

import * as p from '@clack/prompts'
import type { DeploymentTarget, EnvDetection } from './types.js'

function bail<T>(v: T | symbol): asserts v is T {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
}

export async function configureDeployment(
  env: EnvDetection,
): Promise<{ target: DeploymentTarget }> {
  const targetResult = await p.select({
    message: 'How would you like to deploy RivetOS?',
    options: [
      { value: 'docker' as const, label: 'Docker', hint: 'recommended — works anywhere' },
      { value: 'proxmox' as const, label: 'Proxmox LXC', hint: 'homelab — requires Proxmox VE' },
      { value: 'manual' as const, label: 'Manual / Bare Metal', hint: 'you handle infrastructure' },
    ],
  })
  bail(targetResult)
  const target: DeploymentTarget = targetResult

  // Docker selected but not detected
  if (target === 'docker' && !env.dockerAvailable) {
    p.log.warn('Docker was not detected on this system.')
    const contResult = await p.confirm({
      message: 'Continue with Docker anyway? (install it before deploying)',
    })
    bail(contResult)
    if (!contResult) {
      return configureDeployment(env) // Re-ask
    }
  }

  return { target }
}
