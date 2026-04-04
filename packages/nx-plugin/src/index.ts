/**
 * @rivetos/nx — Nx plugin for the RivetOS agent runtime.
 *
 * Generators:
 *   - plugin  — Scaffold a new channel, provider, or tool plugin
 *   - pr      — Interactive PR wizard with quality gates
 *
 * Executors:
 *   - serve   — Run an agent with a specific channel for development
 */

export { pluginGenerator } from './generators/plugin/generator.js'
export { prGenerator } from './generators/pr/generator.js'
export { serveExecutor } from './executors/serve/executor.js'
