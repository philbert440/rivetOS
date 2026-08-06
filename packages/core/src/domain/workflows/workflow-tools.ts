/**
 * Agent start door for workflows — session tools that start/status runs
 * through the same WorkflowEngine instance boot builds.
 *
 * - workflow_start: detached start with agent allowlist (fail-closed)
 * - workflow_status: status + current + openGate summary
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Tool, ToolContext } from '@rivetos/types'
import {
  ContractValidationError,
  findOpenGate,
  listWorkflowDefs,
  readCase,
  readJournal,
  validateStartInput,
  type StartedBy,
  type WorkflowEngine,
} from '@rivetos/workflows'
import { materializeDetachedFailure } from './workflow-api.js'
import { logger } from '../../logger.js'

const log = logger('WorkflowTools')

export interface WorkflowToolsOptions {
  engine: WorkflowEngine
  /** Absolute caseDir root (for detached start caseDir = root/runId). */
  caseDirRoot: string
  /** Def roots for pre-detach contract validation (same list the engine gets). */
  workflowsRoots: string[]
  /**
   * Agent allowlist of workflow ids. Empty/absent = agents may start nothing.
   * Entry `*` allows all workflow ids.
   */
  agentAllowlist?: string[]
  /** Config path shown in fail-closed error messages. */
  allowlistConfigPath?: string
}

const DEFAULT_ALLOWLIST_PATH = 'config.workflows.agent_allowlist'

export function isWorkflowAllowed(workflowId: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return false
  if (allowlist.includes('*')) return true
  return allowlist.includes(workflowId)
}

export function createWorkflowTools(opts: WorkflowToolsOptions): Tool[] {
  const allowlistPath = opts.allowlistConfigPath ?? DEFAULT_ALLOWLIST_PATH
  const allowlist = opts.agentAllowlist

  const startTool: Tool = {
    name: 'workflow_start',
    description:
      'Start a workflow run by id with a structured input object. ' +
      'Returns immediately with runId (detached — does not wait for completion). ' +
      'Use workflow_status to poll. Subject to config.workflows.agent_allowlist.',
    parameters: {
      type: 'object',
      properties: {
        workflow: {
          type: 'string',
          description: 'Workflow id (e.g. "pr-review", "change")',
        },
        input: {
          type: 'object',
          description: 'Input fields matching the workflow input contract',
        },
      },
      required: ['workflow', 'input'],
    },
    execute: async (args, _signal, context?: ToolContext) => {
      try {
        const workflowId = typeof args.workflow === 'string' ? args.workflow : ''
        if (!workflowId) {
          return JSON.stringify({ error: 'workflow is required' })
        }
        const input =
          typeof args.input === 'object' && args.input !== null && !Array.isArray(args.input)
            ? (args.input as Record<string, unknown>)
            : null
        if (!input) {
          return JSON.stringify({ error: 'input must be a JSON object' })
        }

        if (!isWorkflowAllowed(workflowId, allowlist)) {
          const listed =
            allowlist && allowlist.length > 0
              ? allowlist.join(', ')
              : '(empty — agents may start nothing)'
          return JSON.stringify({
            error: `workflow "${workflowId}" is not on the agent allowlist`,
            allowlist: allowlist ?? [],
            hint: `Set ${allowlistPath} to a list of workflow ids, or ["*"] to allow all. Current: ${listed}`,
          })
        }

        // Pre-validate like the gateway API: a detached runId must mean
        // "accepted", never a phantom that only ever existed in a log line.
        const defs = await listWorkflowDefs(opts.workflowsRoots, (m) => log.warn(m))
        const def = defs.find((w) => w.manifest.id === workflowId)
        if (!def) {
          return JSON.stringify({ error: `workflow not found: ${workflowId}` })
        }
        try {
          validateStartInput(def.manifest.input, input)
        } catch (err) {
          if (err instanceof ContractValidationError) {
            return JSON.stringify({ error: err.message, issues: err.issues })
          }
          throw err
        }

        const agentId = context?.agentId ?? context?.session?.agentId ?? 'unknown'
        const startedBy: StartedBy = { type: 'agent', id: agentId }
        const runId = randomUUID()
        const caseDir = join(opts.caseDirRoot, runId)

        // Detached: do not await completion. Failures land in the run's own
        // status — materialized even when startRun dies pre-execute.
        void opts.engine
          .startRun(workflowId, input, startedBy, { runId, caseDir })
          .then((result) => {
            log.info(
              `workflow_start ${workflowId} run=${runId} status=${result.run.status}` +
                (result.suspended ? ` suspended@${result.suspension?.label ?? '?'}` : ''),
            )
          })
          .catch(async (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            log.warn(`workflow_start ${workflowId} run=${runId} failed: ${message}`)
            await materializeDetachedFailure({
              caseDir,
              runId,
              workflowId,
              version: def.manifest.version,
              startedBy,
              message,
            }).catch((e: unknown) => {
              log.warn(
                `workflow_start could not materialize failure for ${runId}: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              )
            })
          })

        return JSON.stringify({
          runId,
          status: 'running',
          suspended: false,
        })
      } catch (err: unknown) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }

  const statusTool: Tool = {
    name: 'workflow_status',
    description:
      'Get status of a workflow run: status, current step cursor, and open human-gate summary if any.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'Run id returned by workflow_start or the gateway API',
        },
      },
      required: ['runId'],
    },
    execute: async (args) => {
      try {
        const runId = typeof args.runId === 'string' ? args.runId : ''
        if (!runId) {
          return JSON.stringify({ error: 'runId is required' })
        }
        const caseDir = await opts.engine.resolveCaseDir(runId)
        const caseState = await readCase(caseDir)
        const journal = await readJournal(caseDir)
        const open = findOpenGate(journal)

        return JSON.stringify({
          runId: caseState.run.id,
          workflowId: caseState.run.workflowId,
          status: caseState.run.status,
          current: caseState.run.current ?? null,
          error: caseState.run.error ?? null,
          output: caseState.run.output ?? null,
          openGate: open
            ? {
                stepId: open.stepId,
                label: open.label,
                seq: open.seq,
                fields: open.fields,
                prompt: open.prompt ?? null,
              }
            : null,
        })
      } catch (err: unknown) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }

  return [startTool, statusTool]
}
