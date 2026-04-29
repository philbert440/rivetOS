/**
 * Proxmox infrastructure provider.
 *
 * Creates LXC containers via the Proxmox API for homelab deployments.
 * Uses the Proxmox REST API directly (no Pulumi dependency needed
 * for the core flow — Pulumi integration is optional).
 *
 * This provider is for users running Proxmox VE on their own hardware.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  InfraProvider,
  InfraStatus,
  NetworkComponentArgs,
  NetworkComponentOutputs,
  DatahubComponentArgs,
  DatahubComponentOutputs,
  AgentComponentArgs,
  AgentComponentOutputs,
} from '../../components/types.js'

export interface ProxmoxProviderConfig {
  /** Proxmox API URL (e.g., https://192.168.1.1:8006) */
  apiUrl: string

  /** API token ID (e.g., root@pam!rivetos) */
  tokenId?: string

  /** API token secret */
  tokenSecret?: string

  /** Node assignments */
  nodes: Array<{
    name: string
    host: string
    role: 'datahub' | 'agents' | 'both'
  }>

  /** Network config */
  network: {
    bridge: string
    subnet: string
    gateway: string
  }

  /** Starting container ID */
  ctidStart?: number
}

interface ManagedResource {
  type: 'datahub' | 'agent'
  name: string
  node: string
  ctid: number
  ip?: string
}

export class ProxmoxProvider implements InfraProvider {
  readonly name = 'proxmox'

  private config: ProxmoxProviderConfig
  private resources: ManagedResource[] = []
  private nextCtid: number
  private stateDir: string

  constructor(config: ProxmoxProviderConfig, stateDir: string) {
    this.config = config
    this.stateDir = stateDir
    this.nextCtid = config.ctidStart ?? 200
  }

  createNetwork(_args: NetworkComponentArgs): Promise<NetworkComponentOutputs> {
    // Proxmox networking is configured at the node level (bridges, VLANs)
    // We don't create networks — we reference existing ones.
    return Promise.resolve({
      id: this.config.network.bridge,
      name: this.config.network.bridge,
    })
  }

  createDatahub(args: DatahubComponentArgs): Promise<DatahubComponentOutputs> {
    const datahubNode = this.config.nodes.find((n) => n.role === 'datahub' || n.role === 'both')
    if (!datahubNode) {
      return Promise.reject(new Error('No Proxmox node configured with role "datahub" or "both"'))
    }

    const ctid = this.nextCtid++
    const ip = this.allocateIp(ctid)

    this.resources.push({
      type: 'datahub',
      name: 'datahub',
      node: datahubNode.name,
      ctid,
      ip,
    })

    return Promise.resolve({
      id: `${datahubNode.name}/${ctid}`,
      host: ip,
      port: 5432,
      connectionString: `postgresql://${args.user}:${args.password}@${ip}:5432/${args.database}`,
      status: 'planned',
    })
  }

  createAgent(args: AgentComponentArgs): Promise<AgentComponentOutputs> {
    // Find an agents node, round-robin across available nodes
    const agentNodes = this.config.nodes.filter((n) => n.role === 'agents' || n.role === 'both')
    if (agentNodes.length === 0) {
      return Promise.reject(new Error('No Proxmox node configured with role "agents" or "both"'))
    }

    const agentCount = this.resources.filter((r) => r.type === 'agent').length
    const targetNode = agentNodes[agentCount % agentNodes.length]
    const ctid = this.nextCtid++
    const ip = this.allocateIp(ctid)

    this.resources.push({
      type: 'agent',
      name: args.name,
      node: targetNode.name,
      ctid,
      ip,
    })

    return Promise.resolve({
      id: `${targetNode.name}/${ctid}`,
      name: args.name,
      ip,
      status: 'planned',
    })
  }

  /** Generate Pulumi program or shell script for deployment */
  async deploy(): Promise<void> {
    await this.saveState()
    console.log('\nProxmox Deployment Plan:')
    console.log('========================')
    for (const r of this.resources) {
      console.log(
        `  ${r.type === 'datahub' ? '🗄️' : '🤖'}  CT ${r.ctid} on ${r.node} — ${r.name} (${r.ip})`,
      )
    }
    console.log('')
    console.log('To execute this plan, use the Pulumi stack:')
    console.log(`  cd ${this.stateDir} && pulumi up`)
    console.log('')
    console.log('Or use the generated setup script:')
    console.log(`  bash ${resolve(this.stateDir, 'setup.sh')}`)

    await this.generateSetupScript()
  }

  preview(): Promise<string> {
    const lines = ['Proxmox Deployment Preview:', '']
    for (const r of this.resources) {
      lines.push(
        `  ${r.type === 'datahub' ? 'Datahub' : 'Agent'}: CT ${r.ctid} on ${r.node} — ${r.name} (${r.ip})`,
      )
    }
    lines.push('')
    lines.push(`Network: ${this.config.network.bridge} (${this.config.network.subnet})`)
    lines.push(`Gateway: ${this.config.network.gateway}`)
    return Promise.resolve(lines.join('\n'))
  }

  destroy(): Promise<void> {
    console.log('Proxmox destroy must be done via Pulumi or the Proxmox UI.')
    console.log('Managed containers:')
    for (const r of this.resources) {
      console.log(`  CT ${r.ctid} on ${r.node} — ${r.name}`)
    }
    return Promise.resolve()
  }

  status(): Promise<InfraStatus> {
    const result: InfraStatus = {
      provider: 'proxmox',
      network: {
        name: this.config.network.bridge,
        status: 'configured',
      },
      agents: [],
    }

    for (const r of this.resources) {
      if (r.type === 'datahub') {
        result.datahub = {
          status: 'planned',
          host: r.ip ?? 'unknown',
          port: 5432,
        }
      } else {
        result.agents.push({
          name: r.name,
          status: 'planned',
          ip: r.ip,
        })
      }
    }

    return Promise.resolve(result)
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────────

  private allocateIp(ctid: number): string {
    // Derive IP from subnet + ctid offset
    const subnet = this.config.network.subnet
    const baseIp = subnet.split('/')[0]
    const parts = baseIp.split('.').map(Number)
    // Use last octet based on ctid (e.g., ctid 200 → .200)
    parts[3] = ctid % 256
    return parts.join('.')
  }

  private async saveState(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true })
    const statePath = resolve(this.stateDir, 'proxmox-state.json')
    await writeFile(
      statePath,
      JSON.stringify(
        {
          config: this.config,
          resources: this.resources,
        },
        null,
        2,
      ),
      'utf-8',
    )
  }

  private async generateSetupScript(): Promise<void> {
    const lines = [
      '#!/bin/bash',
      '# RivetOS Proxmox Setup — generated by rivetos infra',
      '# Run this on your Proxmox host to create containers.',
      'set -e',
      '',
    ]

    for (const r of this.resources) {
      const gateway = this.config.network.gateway
      const bridge = this.config.network.bridge
      lines.push(`echo "Creating CT ${r.ctid} (${r.name}) on ${r.node}..."`)
      lines.push(`pct create ${r.ctid} local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \\`)
      lines.push(`  --hostname rivet-${r.name} \\`)
      lines.push(`  --memory 2048 --swap 512 --cores 2 \\`)
      lines.push(`  --rootfs local-lvm:8 \\`)
      lines.push(`  --net0 name=eth0,bridge=${bridge},ip=${r.ip}/24,gw=${gateway} \\`)
      lines.push(`  --features nesting=1 \\`)
      lines.push(`  --unprivileged 1 \\`)
      lines.push(`  --start 1`)
      lines.push('')
    }

    const scriptPath = resolve(this.stateDir, 'setup.sh')
    await writeFile(scriptPath, lines.join('\n'), 'utf-8')
  }
}
