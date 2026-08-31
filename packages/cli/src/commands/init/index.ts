/**
 * rivetos init — Interactive setup wizard.
 *
 * Walks the user through:
 *   1. Environment detection
 *   2. Deployment target (Docker / Proxmox / Manual)
 *   3. Agent configuration (providers, models, API keys)
 *   3b. Join a RivetHub mesh (optional enroll)
 *   4. Channel configuration (RivetHub; social bots removed)
 *   5. Review & confirm
 *   6. Generate config.yaml + .env + workspace templates + users.json
 *   7. Optional deploy (docker compose up)
 *   8. Legacy mesh ping (if --join was specified)
 */

export { runInitWizard } from './wizard.js'
export type { InitOptions } from './wizard.js'
