/**
 * Command Registry — Single source of truth for all runtime commands.
 *
 * Every consumer reads from here:
 * - queue.ts (isCommand / parseCommand)
 * - commands.ts (CommandHandler.handle switch)
 * - Discord channel (command filtering)
 * - Telegram channel (grammY command registration)
 *
 * To add a new command: add it here, then implement it in CommandHandler.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandDef {
  /** Command name (no slash) */
  name: string
  /** Description shown in /help, Telegram setMyCommands, Discord slash autocomplete */
  description: string
  /** Argument syntax hint, e.g. '<message>' or 'off|low|medium|high' */
  args?: string
  /** If true, command executes immediately even during an active turn. Default: true */
  immediate?: boolean
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const COMMAND_REGISTRY = [
  { name: 'stop' as const, description: 'Stop the current turn' },
  { name: 'interrupt' as const, description: 'Stop and send a new message', args: '<message>' },
  { name: 'steer' as const, description: 'Inject guidance into active turn', args: '<message>' },
  { name: 'new' as const, description: 'Start a fresh session' },
  { name: 'status' as const, description: 'Show runtime status' },
  {
    name: 'model' as const,
    description: 'View or change provider model',
    args: '[provider] [model]',
  },
  { name: 'think' as const, description: 'Set thinking level', args: 'off|low|medium|high' },
  { name: 'reasoning' as const, description: 'Toggle reasoning visibility' },
  { name: 'tools' as const, description: 'Toggle tool call visibility' },
  {
    name: 'context' as const,
    description: 'Manage pinned context files',
    args: 'add|remove|list|clear [file]',
  },
  {
    name: 'clear' as const,
    description: 'Clear queued messages without stopping the current turn',
  },
  { name: 'start' as const, description: 'Show welcome message' },
  { name: 'help' as const, description: 'Show available commands' },
] satisfies CommandDef[]

/** Set of all known command names — for fast lookup */
export const COMMAND_NAMES: ReadonlySet<string> = new Set(COMMAND_REGISTRY.map((c) => c.name))

/** Union type of all command names — derived from the registry */
export type RuntimeCommand = (typeof COMMAND_REGISTRY)[number]['name']
