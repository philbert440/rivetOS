/**
 * RivetHub agent presets as `delegate_task` targets.
 *
 * Resolution order (both engines): local config.yaml agent → preset (id or
 * name) → remote config agent via the mesh. A preset becomes a durable
 * `ros_tasks` row on the hosting node — the caller never names a node.
 * A harness with no headless executor there fails pre-flight; no row is
 * created.
 */

import type { CachedPresetResolver } from '@rivetos/agent-registry'
import type {
  AgentPreset,
  DelegationRequest,
  DelegationResult,
  HarnessId,
  MeshNode,
  MeshRegistry,
} from '@rivetos/types'
import { logger } from '../logger.js'
import { CRITERIA_POLICY_OFF, normalizeCriteria, type CriteriaPolicy } from './task/criteria.js'
import { settleDelegatedTask } from './task/delegation-wait.js'
import { harnessExecutorGap, isNotImplementedHarnessExecutor } from './task/harness-executors.js'
import type { TaskExecutorRegistry } from './task/runner.js'
import type { TaskStore } from './task/store.js'
import type { TaskCompletionWaiter } from './task/completion-waiter.js'

const log = logger('PresetDelegation')

const DEFAULT_MAX_CHAIN_DEPTH = 3
/** Unset timeoutMs caps the wait at 30m, matching mesh delegation. */
const DEFAULT_WAIT_MS = 1_800_000

const TASK_EFFORTS = ['low', 'medium', 'high'] as const
type TaskEffort = (typeof TASK_EFFORTS)[number]

/** Logged once per distinct non-task effort so a fleet of xhigh/max presets does not spam. */
const loggedNonTaskEfforts = new Set<string>()

export interface PresetRosterEntry {
  id: string
  name: string
  harnessId?: HarnessId
  node: string
  local: boolean
  directory?: string
  model?: string
  /** Known headless coverage. Absent when the hosting node has not advertised it. */
  implemented?: boolean
  /** Why it cannot run, when known. */
  gap?: string
}

export interface PresetDelegationConfig {
  resolver: CachedPresetResolver
  taskStore: TaskStore
  waiter: TaskCompletionWaiter
  /** This node — the runner's node id. */
  nodeName: string
  /**
   * Answers "implemented here?" via resolve + isNotImplementedHarnessExecutor.
   * Absent in the mcp-sidecar (slice 4), which then judges the local node the
   * same way as a remote one: via its mesh entry's metadata.harnessExecutors.
   */
  executors?: TaskExecutorRegistry
  /** Answers "implemented on the hosting node?" via node.metadata.harnessExecutors. */
  meshRegistry?: MeshRegistry
  criteriaPolicy?: CriteriaPolicy
  /** Default 3. */
  maxChainDepth?: number
  now?: () => number
}

function isTaskEffort(effort: string): effort is TaskEffort {
  return (TASK_EFFORTS as readonly string[]).includes(effort)
}

function taskEffort(effort: string): TaskEffort | undefined {
  const trimmed = effort.trim()
  if (!trimmed) return undefined
  if (isTaskEffort(trimmed)) return trimmed
  if (!loggedNonTaskEfforts.has(trimmed)) {
    loggedNonTaskEfforts.add(trimmed)
    log.warn(
      `preset effort "${trimmed}" is not a task effort (low|medium|high) — omitting it from the row`,
    )
  }
  return undefined
}

function advertisedHarnesses(node: MeshNode | undefined): string[] | undefined {
  const raw = node?.metadata?.harnessExecutors
  if (!Array.isArray(raw)) return undefined
  return raw.filter((item): item is string => typeof item === 'string')
}

export class PresetDelegationEngine {
  private readonly maxChainDepth: number
  private readonly now: () => number
  /** Last mesh snapshot for synchronous roster coverage. Delegation pre-flight re-reads. */
  private meshSnapshot: MeshNode[] = []

  constructor(private readonly config: PresetDelegationConfig) {
    this.maxChainDepth = config.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH
    this.now = config.now ?? Date.now
    void this.refreshMesh()
  }

  /** resolver.find — id, then exact name, then case-insensitive name. */
  async find(handle: string): Promise<AgentPreset | undefined> {
    await this.refreshMesh()
    return this.config.resolver.find(handle)
  }

  /** From resolver.lastKnown(). Synchronous; remote coverage uses the last mesh snapshot. */
  rosterEntries(): PresetRosterEntry[] {
    return this.config.resolver.lastKnown().map((preset) => this.toRosterEntry(preset))
  }

  /**
   * One line per preset.
   * `- reviewer (agent: codex on ct114 — this node, dir /path)`
   * `- reviewer (agent: kimi-code on ct116, dir /path)`
   * Unimplemented harnesses append ` — NO headless executor: <gap>`.
   * No harness: ` — no harness configured`.
   */
  rosterText(): string {
    return this.rosterEntries()
      .map((entry) => this.formatRosterLine(entry))
      .join('\n')
  }

  async delegate(
    request: DelegationRequest,
    preset: AgentPreset,
    chainDepth = 0,
  ): Promise<DelegationResult> {
    const depth = chainDepth + 1
    if (depth > this.maxChainDepth) {
      return {
        status: 'failed',
        response: `Delegation chain too deep (${String(depth)} > ${String(this.maxChainDepth)}) — refusing mesh delegation to ${request.toAgent}`,
        durationMs: 0,
      }
    }

    const blocked = await this.preflight(preset)
    if (blocked) return blocked

    const harnessId = preset.harnessId
    const node = preset.node
    // preflight already rejected a missing harness or node.
    if (!harnessId || !node) {
      return {
        status: 'failed',
        response: `preset "${preset.name}" is not runnable`,
        durationMs: 0,
      }
    }

    const goal =
      request.task +
      (request.context && request.context.length > 0
        ? `\n\nContext:\n${request.context.join('\n')}`
        : '')
    const origin = node === this.config.nodeName ? 'tool' : 'mesh'
    const describe = `Delegation to ${preset.name} on ${node}`
    const startTime = this.now()
    const waitMs = (request.timeoutMs ?? DEFAULT_WAIT_MS) + 5_000

    const model = request.model ?? (preset.model || undefined)
    const effort = taskEffort(preset.effort)
    const systemPromptAppend = preset.systemPrompt || undefined

    try {
      const row = await this.config.taskStore.create({
        goal,
        executor: 'harness-session',
        executorTarget: harnessId,
        agentId: preset.id,
        origin,
        requestedBy: request.fromAgent,
        nodeAffinity: node,
        chainDepth: depth,
        maxAttempts: 1,
        budget: request.timeoutMs ? { maxWallClockMs: request.timeoutMs } : undefined,
        acceptanceCriteria: normalizeCriteria(
          { goal, origin },
          this.config.criteriaPolicy ?? CRITERIA_POLICY_OFF,
        ),
        spec: {
          delegation: true,
          presetId: preset.id,
          presetName: preset.name,
          meshFrom: this.config.nodeName,
          workingDir: preset.directory,
          sharedLink: preset.sharedLink ?? true,
          // excludeTools is a no-op for harness-session executors (they never
          // consult it). Kept for parity with mesh chat-loop delegations.
          excludeTools: ['delegate_task'],
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(systemPromptAppend ? { systemPromptAppend } : {}),
        },
      })
      return await settleDelegatedTask({
        store: this.config.taskStore,
        waiter: this.config.waiter,
        rowId: row.id,
        waitMs,
        startTime,
        describe,
      })
    } catch (err: unknown) {
      return {
        status: 'failed',
        response: `${describe} failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: this.now() - startTime,
      }
    }
  }

  private async preflight(preset: AgentPreset): Promise<DelegationResult | undefined> {
    if (!preset.harnessId) {
      return {
        status: 'failed',
        response: `preset "${preset.name}" has no harness configured`,
        durationMs: 0,
      }
    }
    if (!preset.node) {
      return {
        status: 'failed',
        response: `preset "${preset.name}" has no hosting node`,
        durationMs: 0,
      }
    }

    const harnessId = preset.harnessId
    const local = preset.node === this.config.nodeName
    if (local && this.config.executors) {
      const executor = this.config.executors.resolve('harness-session', harnessId)
      if (!executor || isNotImplementedHarnessExecutor(executor)) {
        return {
          status: 'failed',
          response: this.gapText(preset, 'this node'),
          durationMs: 0,
        }
      }
      return undefined
    }

    // Remote node, or this node with no executor registry (sidecar): judge
    // coverage from the mesh entry the hosting node advertised.
    if (!this.config.meshRegistry) {
      return {
        status: 'failed',
        response: `no mesh registry; cannot reach node "${preset.node}"`,
        durationMs: 0,
      }
    }
    const nodes = await this.config.meshRegistry.getNodes()
    this.meshSnapshot = nodes
    const host = nodes.find((n) => n.name === preset.node && n.status === 'online')
    if (!host) {
      return {
        status: 'failed',
        response: `hosting node "${preset.node}" is offline or unknown`,
        durationMs: 0,
      }
    }
    const advertised = advertisedHarnesses(host)
    if (advertised && !advertised.includes(harnessId)) {
      return {
        status: 'failed',
        response: this.gapText(preset, preset.node),
        durationMs: 0,
      }
    }
    return undefined
  }

  private gapText(preset: AgentPreset, where: string): string {
    const harnessId = preset.harnessId ?? 'unknown'
    return `agent "${preset.name}" (${harnessId} on ${where}): ${harnessExecutorGap(harnessId)}`
  }

  private async refreshMesh(): Promise<void> {
    if (!this.config.meshRegistry) return
    try {
      this.meshSnapshot = await this.config.meshRegistry.getNodes()
    } catch (err: unknown) {
      log.warn(`Could not read mesh registry for preset roster: ${(err as Error).message}`)
    }
  }

  private toRosterEntry(preset: AgentPreset): PresetRosterEntry {
    const node = preset.node ?? ''
    const local = node !== '' && node === this.config.nodeName
    const entry: PresetRosterEntry = {
      id: preset.id,
      name: preset.name,
      node,
      local,
      ...(preset.harnessId ? { harnessId: preset.harnessId } : {}),
      ...(preset.directory ? { directory: preset.directory } : {}),
      ...(preset.model ? { model: preset.model } : {}),
    }
    if (!preset.harnessId) {
      entry.gap = 'no harness configured'
      return entry
    }
    const coverage = this.coverage(preset, local)
    if (coverage) {
      entry.implemented = coverage.implemented
      if (!coverage.implemented) entry.gap = coverage.gap
    }
    return entry
  }

  private coverage(
    preset: AgentPreset,
    local: boolean,
  ): { implemented: boolean; gap?: string } | undefined {
    const harnessId = preset.harnessId
    if (!harnessId) return undefined
    if (local && this.config.executors) {
      const executor = this.config.executors.resolve('harness-session', harnessId)
      if (!executor || isNotImplementedHarnessExecutor(executor)) {
        return { implemented: false, gap: harnessExecutorGap(harnessId) }
      }
      return { implemented: true }
    }
    const host = this.meshSnapshot.find((n) => n.name === preset.node && n.status === 'online')
    const advertised = advertisedHarnesses(host)
    if (!advertised) return undefined
    if (!advertised.includes(harnessId)) {
      return { implemented: false, gap: harnessExecutorGap(harnessId) }
    }
    return { implemented: true }
  }

  private formatRosterLine(entry: PresetRosterEntry): string {
    const where = entry.local ? `${entry.node} — this node` : entry.node || 'unknown'
    const dir = entry.directory ? `, dir ${entry.directory}` : ''
    if (!entry.harnessId) {
      const place = entry.node ? ` (on ${where}${dir})` : ''
      return `- ${entry.name}${place} — no harness configured`
    }
    let line = `- ${entry.name} (agent: ${entry.harnessId} on ${where}${dir})`
    if (entry.implemented === false) {
      line += ` — NO headless executor: ${entry.gap ?? harnessExecutorGap(entry.harnessId)}`
    }
    return line
  }
}
