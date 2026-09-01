/**
 * One accent for agent-rail dots and conversation-row stripes.
 *
 * A named preset colour wins when it is a real hex; otherwise the harness
 * palette (claude clay / grok grey / local emerald). Same inputs → same
 * colour on both surfaces.
 */

import { harnessAccent } from './harness-colors.js'

/** 3- or 6-digit hex, matching the agent editor's colour field. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function accentFor(input: {
  presetColor?: string
  harnessId?: string
  command?: string
}): string {
  const preset = input.presetColor?.trim()
  if (preset && HEX.test(preset)) return preset
  return harnessAccent(input.harnessId ?? input.command)
}
