/**
 * Per-harness accent colors so the bots are recognizable at a glance:
 * claude wears Anthropic's clay, grok a neutral grey, and local/rivet
 * agents the house emerald. Used for drawer dots and chat avatars.
 */

function isOpencodeId(command: string): boolean {
  return command === 'opencode' || command === 'opencode-cli' || command.startsWith('opencode:')
}

export function harnessAccent(command?: string): string {
  const c = (command ?? '').toLowerCase()
  if (c.includes('claude')) return '#CC785C' // Anthropic clay
  if (c.includes('grok')) return '#9ca3af' // neutral grey
  if (isOpencodeId(c)) return '#f97316' // OpenCode orange — not clay / grey / blue / emerald
  if (c.includes('codex')) return '#5b8def' // Codex blue — not clay / grey / emerald
  return '#34d399' // local / rivet emerald
}
