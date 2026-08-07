/**
 * Deployment configuration types for rivet.config.yaml.
 *
 * These types define the infrastructure layer — HOW agents are deployed,
 * not what they do (that's RuntimeConfig/AgentConfig).
 *
 * The deployment section is optional: if omitted, RivetOS runs bare-metal
 * (current behavior). Only `target` is consumed at runtime; provisioning is
 * driven by Compose files under `infra/docker/` and scripts under
 * `infra/scripts/`.
 */

// ---------------------------------------------------------------------------
// Top-level deployment config
// ---------------------------------------------------------------------------

export type DeploymentTarget = 'docker' | 'proxmox' | 'kubernetes' | 'manual'

export interface DeploymentConfig {
  /** Deployment target — determines which provisioner/tooling path to use */
  target: DeploymentTarget
}
