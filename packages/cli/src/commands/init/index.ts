/**
 * rivetos init — Interactive setup wizard.
 *
 * Walks the user through:
 *   1. Environment detection
 *   2. Deployment target (Docker / Proxmox / Manual)
 *   3. Agent configuration (providers, models, API keys)
 *   4. Channel configuration (Discord, Telegram, terminal)
 *   5. Review & confirm
 *   6. Generate config.yaml + .env + workspace templates
 *   7. Optional deploy (docker compose up / pulumi up)
 *   8. Mesh join (if --join was specified)
 */

export { runInitWizard } from './wizard.js'
export type { InitOptions } from './wizard.js'
