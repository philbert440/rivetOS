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

/** RivetHub mesh enroll answers collected after provider setup. */
export interface WizardMeshJoin {
  /** Datahub SSH target (`user@host`). */
  hub: string
  /** Certificate CN / mesh node name. */
  name: string
  /** Address other nodes use to reach this host. Omitted → enroll default. */
  advertise?: string
}

export interface WizardState {
  deployment: DeploymentTarget
  agents: WizardAgent[]
  /** Always empty after Phase 5 (telegram/discord removed). */
  channels: WizardChannel[]
  postgresPassword: string
  /** Full postgres connection string. For manual deployments the wizard prompts the user; for docker/proxmox it is generated against the bundled datahub. */
  postgresUrl?: string
  /** Owner id for the users.json seed (default "owner"). */
  ownerId: string
  /** Present when the operator chose to join a RivetHub mesh. */
  meshJoin?: WizardMeshJoin
  /**
   * Mesh YAML section taken from a successful enroll result. Written into
   * generated config.yaml — not the leftover "add channels.agent by hand" path.
   */
  meshSection?: Record<string, unknown>
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
