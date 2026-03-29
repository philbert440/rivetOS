/**
 * Backward-compatibility re-export.
 *
 * The Runtime class has been decomposed into focused modules under
 * packages/core/src/runtime/. This file re-exports for anyone who
 * was importing from the old path.
 */

export { Runtime } from './runtime/runtime.js';
export type { RuntimeConfig } from './runtime/runtime.js';
