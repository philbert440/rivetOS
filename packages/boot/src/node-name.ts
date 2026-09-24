import type { RivetConfig } from './config.js'

/**
 * Mesh node NAME the task runner claims `ros_tasks` rows on, and the string
 * den stamps onto `preset.node`. Empty and whitespace do not count: a blank
 * `mesh.node_name` must not wedge affinity on `""`.
 */
export function nodeNameFor(config: RivetConfig): string {
  return config.mesh?.node_name?.trim() || process.env.HOSTNAME?.trim() || 'local'
}
