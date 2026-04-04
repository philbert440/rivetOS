/**
 * Runtime module barrel — re-exports the decomposed runtime components.
 */

export { Runtime } from './runtime.js';
export type { RuntimeConfig } from './runtime.js';
export { CommandHandler } from './commands.js';
export type { CommandDeps } from './commands.js';
export { StreamManager } from './streaming.js';
export type { SessionStreamState } from './streaming.js';
export { SessionManager } from './sessions.js';
export { TurnHandler } from './turn-handler.js';
export type { TurnHandlerDeps } from './turn-handler.js';
export { resolveAttachments, buildHistoryContent } from './media.js';
export type { MediaResult } from './media.js';
