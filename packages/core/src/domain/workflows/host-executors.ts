/**
 * Host ExecutorRegistry for RivetOS — script run + task-backed agent.
 * Constructed in boot and passed to WorkflowEngine; never imported by
 * workflow orchestration scripts.
 */

import type { ExecutorRegistry } from '@rivetos/workflows'
import type { TaskStore } from '../task/store.js'
import type { TaskCompletionWaiter } from '../task/completion-waiter.js'
import { createStubAgentExecutor, createTaskAgentExecutor } from './agent-executor.js'
import { createScriptRunExecutor } from './script-run-executor.js'

export interface HostExecutorRegistryOptions {
  taskStore?: TaskStore
  taskWaiter?: TaskCompletionWaiter
  defaultAgentId: string
  nodeId?: string
  defaultStepTimeoutMs?: number
}

export function createHostExecutorRegistry(opts: HostExecutorRegistryOptions): ExecutorRegistry {
  const agent =
    opts.taskStore && opts.taskWaiter
      ? createTaskAgentExecutor({
          store: opts.taskStore,
          waiter: opts.taskWaiter,
          defaultAgentId: opts.defaultAgentId,
          nodeId: opts.nodeId,
          defaultTimeoutMs: opts.defaultStepTimeoutMs,
        })
      : createStubAgentExecutor(
          'task store / completion waiter not configured (tasks disabled or no pg)',
        )

  const run = createScriptRunExecutor({
    defaultTimeoutMs: opts.defaultStepTimeoutMs,
  })

  return { agent, run }
}
