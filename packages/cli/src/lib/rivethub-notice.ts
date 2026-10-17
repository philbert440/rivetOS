/**
 * One-line pointer from the TypeScript runtime commands to RivetHub.
 *
 * `rivetos start` and `rivetos update` print it once per invocation, on
 * stderr so nothing that parses their stdout changes. It is deliberately not
 * a logger hook: one line at the top of the run, never one per log line.
 */

export const RIVETHUB_NOTICE =
  'ℹ️  RivetOS is moving to the RivetHub runtime — see `rivetos migrate-to-rivethub --dry-run` (docs/migrating-to-rivethub.md).'

let shown = false

export function printRivethubNotice(write: (line: string) => void = console.error): void {
  if (shown) return
  shown = true
  write(RIVETHUB_NOTICE)
}

/** Test hook: allow the notice to print again. */
export function resetRivethubNotice(): void {
  shown = false
}
