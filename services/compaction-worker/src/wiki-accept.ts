/**
 * The `accept` check the wiki tasks pass to callLlm: a reply that is not JSON
 * at all goes to the next fallback endpoint for that one call. Bad entries
 * inside valid JSON do not; the parsers drop those patch by patch.
 */

/**
 * How parseWikiPatches and parseRecompileResult (@rivetos/memory-postgres)
 * start the rejection for a reply that is not JSON. wiki-accept.test.ts runs
 * both parsers against it, so a reword there fails the test instead of
 * silently switching this failover off.
 */
export const UNPARSEABLE_JSON = 'unparseable JSON'

/** Null to accept, or the reason to reject, from a parser's rejection(s). */
export function rejectUnparseable(rejected: string | string[] | undefined): string | null {
  const list = Array.isArray(rejected) ? rejected : rejected ? [rejected] : []
  return list.some((r) => r.startsWith(UNPARSEABLE_JSON)) ? UNPARSEABLE_JSON : null
}
