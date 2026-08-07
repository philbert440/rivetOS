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
  baseUrl?: string // For ollama/vllm/llama-server
}

export interface WizardChannel {
  type: 'discord' | 'telegram'
  botToken: string // Stored in .env, not config
  ownerId: string
}

export interface WizardState {
  deployment: DeploymentTarget
  agents: WizardAgent[]
  channels: WizardChannel[]
  postgresPassword: string
  /** Full postgres connection string. For manual deployments the wizard prompts the user; for docker/proxmox it is generated against the bundled datahub. */
  postgresUrl?: string
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
