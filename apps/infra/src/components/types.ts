/**
 * Abstract infrastructure component types.
 *
 * These define WHAT gets deployed, not HOW. Each provider
 * (Docker, Proxmox, Kubernetes) implements these interfaces
 * using its own primitives.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Agent
// ──────────────────────────────────────────────────────────────────────────────

export interface AgentComponentArgs {
  /** Agent name (e.g., "opus", "grok") */
  name: string

  /** AI provider (e.g., "anthropic", "xai") */
  provider: string

  /** Model name */
  model: string

  /** Path to config.yaml (mounted read-only) */
  configPath: string

  /** Path to .env file for secrets */
  envPath: string

  /** Path to workspace directory */
  workspacePath: string

  /** Datahub connection info */
  datahub: {
    host: string
    port: number
    database: string
  }

  /** Shared storage mount path */
  sharedMountPath: string

  /** Container image (if using pre-built) */
  image?: string

  /** Build from source directory */
  sourceDir?: string

  /** Environment variables to inject */
  env?: Record<string, string>
}

export interface AgentComponentOutputs {
  /** Container/instance ID */
  id: string

  /** Agent name */
  name: string

  /** IP address (if applicable) */
  ip?: string

  /** Status description */
  status: string
}

// ──────────────────────────────────────────────────────────────────────────────
// Datahub
// ──────────────────────────────────────────────────────────────────────────────

export interface DatahubComponentArgs {
  /** Postgres version (default: "16") */
  postgresVersion?: string

  /** Postgres user */
  user: string

  /** Postgres password */
  password: string

  /** Database name */
  database: string

  /** Expose Postgres port on host (0 = don't expose) */
  exposePort?: number

  /** Container image (if using pre-built) */
  image?: string

  /** Build from source directory */
  sourceDir?: string
}

export interface DatahubComponentOutputs {
  /** Container/instance ID */
  id: string

  /** Hostname for agents to connect to */
  host: string

  /** Port */
  port: number

  /** Full connection string */
  connectionString: string

  /** Status */
  status: string
}

// ──────────────────────────────────────────────────────────────────────────────
// Network
// ──────────────────────────────────────────────────────────────────────────────

export interface NetworkComponentArgs {
  /** Network name */
  name: string

  /** Subnet CIDR (optional, provider may auto-assign) */
  subnet?: string

  /** Gateway (optional) */
  gateway?: string
}

export interface NetworkComponentOutputs {
  /** Network ID */
  id: string

  /** Network name */
  name: string
}

// ──────────────────────────────────────────────────────────────────────────────
// Provider interface
// ──────────────────────────────────────────────────────────────────────────────

export interface InfraProvider {
  /** Provider name for display */
  readonly name: string

  /** Create the network */
  createNetwork(args: NetworkComponentArgs): Promise<NetworkComponentOutputs>

  /** Create the datahub (Postgres + shared storage) */
  createDatahub(args: DatahubComponentArgs): Promise<DatahubComponentOutputs>

  /** Create an agent instance */
  createAgent(args: AgentComponentArgs): Promise<AgentComponentOutputs>

  /** Destroy all managed resources */
  destroy(): Promise<void>

  /** Get status of all resources */
  status(): Promise<InfraStatus>
}

export interface InfraStatus {
  provider: string
  network?: { name: string; status: string }
  datahub?: { status: string; host: string; port: number }
  agents: Array<{ name: string; status: string; ip?: string }>
}
