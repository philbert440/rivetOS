/**
 * Deployment configuration types for rivet.config.yaml.
 *
 * These types define the infrastructure layer — HOW agents are deployed,
 * not what they do (that's RuntimeConfig/AgentConfig).
 *
 * The deployment section is optional: if omitted, RivetOS runs bare-metal
 * (current behavior). When present, it drives containerized deployment
 * via Docker, Proxmox, or Kubernetes.
 */

// ---------------------------------------------------------------------------
// Top-level deployment config
// ---------------------------------------------------------------------------

export type DeploymentTarget = 'docker' | 'proxmox' | 'kubernetes' | 'manual'

export interface DeploymentConfig {
  /** Deployment target — determines which provider creates the infrastructure */
  target: DeploymentTarget

  /** Datahub configuration (Postgres + shared storage) */
  datahub?: DatahubConfig

  /** Container image settings */
  image?: ImageConfig

  /** Provider-specific overrides */
  docker?: DockerConfig
  proxmox?: ProxmoxConfig
  kubernetes?: KubernetesConfig
}

// ---------------------------------------------------------------------------
// Datahub
// ---------------------------------------------------------------------------

export interface DatahubConfig {
  /** Enable Postgres (default: true) */
  postgres?: boolean

  /** Postgres version (default: "16") */
  postgresVersion?: string

  /** Enable shared storage volume (default: true) */
  sharedStorage?: boolean

  /** Shared storage mount path inside containers (default: "/rivet-shared") */
  sharedMountPath?: string
}

// ---------------------------------------------------------------------------
// Image config
// ---------------------------------------------------------------------------

export interface ImageConfig {
  /** Container registry (default: "ghcr.io/philbert440") */
  registry?: string

  /** Agent image name (default: "rivetos-agent") */
  agentImage?: string

  /** Image tag (default: "latest") */
  tag?: string

  /** Build from source instead of pulling pre-built (default: true) */
  buildFromSource?: boolean
}

// ---------------------------------------------------------------------------
// Docker-specific
// ---------------------------------------------------------------------------

export interface DockerConfig {
  /** Docker network name (default: "rivetos-net") */
  network?: string

  /** Expose Postgres port on host (default: 5432, set to 0 to disable) */
  postgresPort?: number

  /** Docker Compose project name (default: "rivetos") */
  projectName?: string
}

// ---------------------------------------------------------------------------
// Proxmox-specific
// ---------------------------------------------------------------------------

export interface ProxmoxConfig {
  /** Proxmox API endpoint */
  apiUrl?: string

  /** Proxmox nodes and their roles */
  nodes?: ProxmoxNodeConfig[]

  /** Network configuration */
  network?: ProxmoxNetworkConfig
}

export interface ProxmoxNodeConfig {
  /** Node name (e.g., "pve1") */
  name: string

  /** Node IP or hostname */
  host?: string

  /** Role: datahub runs DB + NFS, agents run agent containers */
  role: 'datahub' | 'agents' | 'both'

  /** Container ID start range for this node (e.g., 100) */
  ctidStart?: number
}

export interface ProxmoxNetworkConfig {
  /** Bridge name (default: "vmbr0") */
  bridge?: string

  /** Subnet CIDR (e.g., "192.168.1.0/24") */
  subnet?: string

  /** Gateway IP */
  gateway?: string
}

// ---------------------------------------------------------------------------
// Kubernetes-specific (future)
// ---------------------------------------------------------------------------

export interface KubernetesConfig {
  /** Kubernetes namespace (default: "rivetos") */
  namespace?: string

  /** Storage class for PVCs */
  storageClass?: string

  /** Resource limits per agent pod */
  resources?: {
    cpu?: string
    memory?: string
  }
}
