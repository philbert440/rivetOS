/**
 * Engine configuration.
 *
 * caseDir root is always supplied via config — never scatter hardcoded
 * filesystem roots through library code. The default value below is the
 * RivetOS backing store path; other deployments inject their own root.
 */

import { sharedPath } from '@rivetos/types'
import type { ExecutorRegistry } from './executors.js'
import type { CallRegistry } from './registry.js'

/** Default case-dir root for RivetOS host deployments (override in tests/config). */
export const DEFAULT_CASE_DIR_ROOT = sharedPath('workflows', 'runs')

/** Default per-step timeout (30 minutes) — generous; product says engine defaults day one. */
export const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000

/** Default max run wall-clock (24 hours). Enforcement at engine boundary; see NOTES. */
export const DEFAULT_MAX_RUN_RUNTIME_MS = 24 * 60 * 60 * 1000

export interface EngineConfig {
  /**
   * Root directory under which run caseDirs are created.
   * Required for production; tests always pass a temp dir.
   * If omitted, DEFAULT_CASE_DIR_ROOT is used.
   */
  caseDirRoot?: string

  /**
   * Root(s) where bare workflow refs resolve to directories.
   * First match of `<root>/<ref>/workflow.yaml` wins.
   */
  workflowsRoots?: string[]

  /** Per-step timeout passed to executors when they support it. */
  defaultStepTimeoutMs?: number

  /** Max wall-clock for a single run execution attempt (start or resume). */
  maxRunRuntimeMs?: number

  /** Injected executor backends (agent, run). Required. */
  executors: ExecutorRegistry

  /**
   * Namespaced call registry. If omitted, a registry with only the native
   * workflow resolver is built by the engine.
   */
  callRegistry?: CallRegistry

  /**
   * Optional map of workflow id → absolute directory for tests / explicit pins.
   * Checked before workflowsRoots.
   */
  workflowDirs?: Record<string, string>
}

export function resolveCaseDirRoot(config: EngineConfig): string {
  return config.caseDirRoot ?? sharedPath('workflows', 'runs')
}

export function resolveStepTimeoutMs(config: EngineConfig): number {
  return config.defaultStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
}

export function resolveMaxRunRuntimeMs(config: EngineConfig): number {
  return config.maxRunRuntimeMs ?? DEFAULT_MAX_RUN_RUNTIME_MS
}
