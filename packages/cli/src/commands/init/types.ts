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

/** Social channel wizard entries were removed in Phase 5; always empty. */
export type WizardChannel = { readonly _brand?: 'removed-social-channel' }

export interface WizardState {
  deployment: DeploymentTarget
  agents: WizardAgent[]
  /** Always empty after Phase 5 (telegram/discord removed). */
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
