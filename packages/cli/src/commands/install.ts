/**
 * rivetos install — provision optional per-node components.
 *
 *   rivetos install --herdr                     Install pinned herdr 0.8.2 +
 *                                               manifest overrides on this node
 *   rivetos install --herdr --from-upstream     Allow the unpinned upstream
 *                                               installer as a fallback
 *
 * Provisioning is behavior-neutral: nothing runs herdr until the den's
 * term.mux flips to herdr (RIVETOS_DEN_TERM_MUX=herdr). See
 * integrations/herdr/README.md.
 */

import { installHerdr } from '../lib/herdr.js'

function showHelp(): void {
  console.log(`Usage: rivetos install --herdr [--from-upstream]

Provisions optional per-node components. Currently only --herdr.

Options:
  --herdr           Install pinned herdr 0.8.2 to ~/.local/bin/herdr
                    (sha256-verified staged binary) and drop the repo's
                    agent-detection manifest overrides into herdr's remote
                    cache dir. Idempotent.
  --from-upstream   Fallback: run the upstream installer (no pin support)
                    and accept it only if it lands the pinned version.
  -h, --help        Show this help
`)
}

export default function install(args: string[]): void {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    showHelp()
    if (args.length === 0) process.exit(1)
    return
  }

  if (args.includes('--herdr')) {
    try {
      installHerdr({
        allowUpstream: args.includes('--from-upstream'),
        log: (msg) => console.log(msg),
      })
    } catch (err: unknown) {
      console.error(`❌ herdr install failed: ${(err as Error).message}`)
      process.exit(1)
    }
    return
  }

  console.error(`Unknown install target: ${args.join(' ')}`)
  showHelp()
  process.exit(1)
}
