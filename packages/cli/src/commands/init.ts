/**
 * rivetos init — Interactive setup wizard.
 *
 * Usage:
 *   rivetos init                    Full interactive setup
 *   rivetos init --join <host>      Join an existing mesh (runs wizard + mesh join)
 *
 * Delegates to the multi-phase wizard in ./init/ directory.
 */

import { runInitWizard } from './init/index.js'

export default async function init(): Promise<void> {
  const args = process.argv.slice(3)
  const joinIndex = args.indexOf('--join')
  const joinHost = joinIndex >= 0 ? args[joinIndex + 1] : undefined

  // If --join is specified, run the wizard with mesh join baked in
  await runInitWizard({ joinHost })
}
