/**
 * Phase 2: Deployment target selection.
 */

import * as p from '@clack/prompts'
import type { DeploymentTarget, EnvDetection, ProxmoxSetup, ProxmoxNode } from './types.js'

function bail<T>(v: T | symbol): asserts v is T {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
}

export async function configureDeployment(
  env: EnvDetection,
): Promise<{ target: DeploymentTarget; proxmox?: ProxmoxSetup }> {
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

  // Proxmox setup
  if (target === 'proxmox') {
    const proxmox = await configureProxmox()
    return { target, proxmox }
  }

  return { target }
}

async function configureProxmox(): Promise<ProxmoxSetup> {
  const apiUrlResult = await p.text({
    message: 'Proxmox API URL',
    placeholder: 'https://192.168.1.1:8006',
    defaultValue: 'https://localhost:8006',
  })
  bail(apiUrlResult)
  const apiUrl: string = apiUrlResult

  const nodeCountResult = await p.select({
    message: 'How many Proxmox nodes?',
    options: [
      { value: 1 as const, label: '1 node' },
      { value: 2 as const, label: '2 nodes' },
      { value: 3 as const, label: '3 nodes' },
    ],
  })
  bail(nodeCountResult)
  const nodeCount: number = nodeCountResult

  const nodes: ProxmoxNode[] = []
  for (let i = 0; i < nodeCount; i++) {
    p.log.info(`\nConfiguring node ${i + 1} of ${nodeCount}:`)

    const nameResult = await p.text({
      message: 'Node name',
      placeholder: `pve${i + 1}`,
      defaultValue: `pve${i + 1}`,
    })
    bail(nameResult)
    const name: string = nameResult

    const hostResult = await p.text({
      message: 'Node IP or hostname',
      placeholder: `192.168.1.${i + 1}`,
    })
    bail(hostResult)
    const host: string = hostResult

    const roleResult = await p.select({
      message: 'Node role',
      options: [
        {
          value: 'both' as const,
          label: 'Both (datahub + agents)',
          hint: nodeCount === 1 ? 'recommended for single node' : undefined,
        },
        { value: 'datahub' as const, label: 'Datahub only', hint: 'database + shared storage' },
        { value: 'agents' as const, label: 'Agents only', hint: 'runs agent containers' },
      ],
      initialValue: i === 0 && nodeCount > 1 ? ('datahub' as const) : ('both' as const),
    })
    bail(roleResult)
    const role: 'datahub' | 'agents' | 'both' = roleResult

    nodes.push({ name, host, role })
  }

  // Network
  p.log.info('\nNetwork configuration:')

  const bridgeResult = await p.text({
    message: 'Bridge interface',
    placeholder: 'vmbr0',
    defaultValue: 'vmbr0',
  })
  bail(bridgeResult)
  const bridge: string = bridgeResult

  const subnetResult = await p.text({
    message: 'Subnet CIDR',
    placeholder: '192.168.1.0/24',
  })
  bail(subnetResult)
  const subnet: string = subnetResult

  const gatewayResult = await p.text({
    message: 'Gateway IP',
    placeholder: '192.168.1.1',
  })
  bail(gatewayResult)
  const gateway: string = gatewayResult

  return {
    apiUrl,
    nodes,
    network: { bridge, subnet, gateway },
  }
}
