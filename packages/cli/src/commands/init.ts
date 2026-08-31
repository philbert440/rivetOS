/**
 * rivetos init — Interactive setup wizard.
 *
 * Usage:
 *   rivetos init                         Full interactive setup
 *   rivetos init --join <host>           Legacy seed-node ping after the wizard
 *   rivetos init --answers-file <path>   Non-interactive (JSON answers)
 *
 * Delegates to the multi-phase wizard in ./init/ directory.
 */

import { runInitWizard, type InitOptions } from './init/index.js'

/** Flag parse for `rivetos init` / `rivetos config init`. Name-based, not positional. */
export function parseInitArgs(args: string[]): InitOptions {
  let joinHost: string | undefined
  let answersFile: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--join') {
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        joinHost = value
        i++
      }
    } else if (a === '--answers-file') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--answers-file requires a path')
      }
      answersFile = value
      i++
    }
  }
  return { joinHost, answersFile }
}

export default async function init(args: string[] = process.argv.slice(3)): Promise<void> {
  // If --join is specified, run the wizard with mesh join baked in
  await runInitWizard(parseInitArgs(args))
}
