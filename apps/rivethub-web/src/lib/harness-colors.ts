/**
 * Per-harness accent colors so the bots are recognizable at a glance:
 * claude wears Anthropic's clay, grok a neutral grey, and local/rivet
 * agents the house emerald. Used for drawer dots and chat avatars.
 */

export function harnessAccent(command?: string): string {
  const c = (command ?? '').toLowerCase()
  if (c.includes('claude')) return '#CC785C' // Anthropic clay
  if (c.includes('grok')) return '#9ca3af' // neutral grey
  return '#34d399' // local / rivet emerald
}
