/**
 * @rivetos/core — The agent runtime.
 *
 * This is the center of RivetOS. It wires channels to providers,
 * injects workspace context, runs the tool loop, and manages lifecycle.
 *
 * ~500 lines. If it grows past 800, something went wrong.
 */

export { Runtime } from './runtime.js';
export { AgentLoop } from './loop.js';
export { Router } from './router.js';
export { WorkspaceLoader } from './workspace.js';
