import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * den's state directory. The same expression `services/den-server` `loadConfig`
 * uses, so boot and den cannot pick different `agents.json` files.
 */
export function denStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.RIVETOS_DEN_STATE_DIR ?? join(homedir(), '.rivetos', 'den')
}
