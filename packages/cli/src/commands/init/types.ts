/**
 * Shared types for the init wizard state.
 */

export type DeploymentTarget = 'docker' | 'proxmox' | 'manual'

export interface WizardAgent {
  name: string
  provider: string
  model: string
  thinking: string
  apiKey?: string // Stored in .env, not config
  baseUrl?: string // For ollama/llama-server/openai-compat
}

export interface WizardChannel {
  type: 'discord' | 'telegram'
  botToken: string // Stored in .env, not config
  ownerId: string
}

export interface ProxmoxNode {
  name: string
  host: string
  role: 'datahub' | 'agents' | 'both'
}

export interface ProxmoxSetup {
  apiUrl: string
  nodes: ProxmoxNode[]
  network: {
    bridge: string
    subnet: string
    gateway: string
  }
}

export interface WizardState {
  deployment: DeploymentTarget
  agents: WizardAgent[]
  channels: WizardChannel[]
  proxmox?: ProxmoxSetup
  postgresPassword: string
}

export interface EnvDetection {
  nodeVersion: string
  nodeOk: boolean
  dockerAvailable: boolean
  dockerVersion?: string
  configExists: boolean
  configPath: string
  rivetDir: string
}
