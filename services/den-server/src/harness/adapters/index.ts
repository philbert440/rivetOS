import { claudeAdapter } from './claude.js'
import { codexAdapter } from './codex.js'
import { grokAdapter } from './grok.js'
import { hermesAdapter } from './hermes.js'
import { kimiAdapter } from './kimi.js'
import { opencodeAdapter } from './opencode.js'
import { piAdapter } from './pi.js'
import type { HarnessAdapter } from './types.js'

export type { HarnessAdapter, HarnessStoreRef } from './types.js'
export { claudeTurnsFromLines, claudeAdapter } from './claude.js'
export { kimiTurnsFromLines, kimiAdapter } from './kimi.js'
export { grokPickTurn, grokTurnsFromLines, grokAdapter } from './grok.js'
export { readHermesTurns, hermesAdapter } from './hermes.js'
export { codexTurnsFromLines, codexAdapter } from './codex.js'
export { opencodeTurnsFromMessages, readOpencodeTurns, opencodeAdapter } from './opencode.js'
export { piTurnsFromLines, piAdapter } from './pi.js'

const BY_COMMAND: Record<string, HarnessAdapter> = {
  claude: claudeAdapter,
  grok: grokAdapter,
  kimi: kimiAdapter,
  hermes: hermesAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter,
}

export function adapterForCommand(command: string): HarnessAdapter | undefined {
  return BY_COMMAND[command]
}
