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

/** Flag parse for `rivetos init` / `rivetos config init`. Name-based, not positional. */
export function parseInitArgs(args: string[]): { joinHost?: string } {
  const joinIndex = args.indexOf('--join')
  const joinHost = joinIndex >= 0 ? args[joinIndex + 1] : undefined
  return { joinHost }
}

export default async function init(args: string[] = process.argv.slice(3)): Promise<void> {
  // If --join is specified, run the wizard with mesh join baked in
  await runInitWizard(parseInitArgs(args))
}
