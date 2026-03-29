/**
 * @rivetos/memory-postgres-lcm
 *
 * Memory plugin that adapts over the existing LCM PostgreSQL schema.
 * No migration. No new tables. Reads and writes the same tables that
 * OpenClaw's LCM plugin uses: messages, message_parts, conversations,
 * summaries, summary_parents, summary_messages.
 *
 * 69K messages, 2K summaries, 72K message parts — all preserved.
 */

export { LcmMemory } from './adapter.js';
export { LcmSearchEngine } from './search.js';
export { LcmExpander } from './expand.js';
export { createMemoryTools } from './tools.js';
