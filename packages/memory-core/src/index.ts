/**
 * @rivetos/memory-core
 *
 * The backend-neutral half of the RivetOS memory system: relevance scoring
 * and the hybrid fusion policy, the compaction prompts and formatters, the
 * wiki extraction prompts and patch parsing, the tagger prompt and parser,
 * and what text gets embedded. No database and no network, so every memory
 * backend (Postgres, SQLite) ranks, summarizes, tags and extracts the same
 * way. One module reads the filesystem: project-rule.ts, the bounded probe
 * behind the rule-based project tag. It is Node-only; the rest is pure.
 */

export * from './scoring.js'
export * from './fusion.js'
export * from './compactor/index.js'
export * from './wiki-prompts.js'
export * from './embed/index.js'
export * from './window.js'
export * from './wiki-tags.js'
export * from './tagger.js'
export * from './project-rule.js'
export * from './cowork-dedupe.js'
export * from './portability-columns.js'
