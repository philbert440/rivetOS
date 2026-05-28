/**
 * Local node identity resolution.
 *
 * The node name is the CN on this node's mTLS client cert — it proves who *we*
 * are when calling mesh peers, so it is deliberately derived from local config,
 * never from the target host.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Resolve this node's name (the CN on its mTLS client cert).
 *
 * Resolution order:
 *   1. `RIVETOS_NODE_NAME` env var (explicit override)
 *   2. `mesh.node_name` from `~/.rivetos/config.yaml` (canonical)
 *   3. top-level `node_name` (legacy fallback)
 *   4. `null` — caller decides what to do (typically: skip mTLS, fall back)
 */
export function resolveLocalNodeName(): string | null {
  if (process.env.RIVETOS_NODE_NAME) return process.env.RIVETOS_NODE_NAME
  try {
    const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
    const raw = readFileSync(configPath, 'utf-8')
    const config = parseYaml(raw) as { node_name?: string; mesh?: { node_name?: string } } | null
    if (config?.mesh?.node_name) return config.mesh.node_name
    if (config?.node_name) return config.node_name
  } catch {
    // No config file or unparseable — fall through to null
  }
  return null
}
