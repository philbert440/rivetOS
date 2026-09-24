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
  HarnessExecutor,
  HarnessId,
  MeshNode,
  MeshRegistry,
} from '@rivetos/types'
import { logger } from '../logger.js'
import { CRITERIA_POLICY_OFF, normalizeCriteria, type CriteriaPolicy } from './task/criteria.js'
import { settleDelegatedTask } from './task/delegation-wait.js'
import {
  canonicalizeExecutorTarget,
  harnessExecutorGap,
  isNotImplementedHarnessExecutor,
  notImplementedHarnessReason,
} from './task/harness-executors.js'
import type { TaskExecutorRegistry } from './task/runner.js'
import type { TaskStore } from './task/store.js'
import type { TaskCompletionWaiter } from './task/completion-waiter.js'

const log = logger('PresetDelegation')

const DEFAULT_MAX_CHAIN_DEPTH = 3
/** Unset timeoutMs caps the wait at 30m, matching mesh delegation. */
const DEFAULT_WAIT_MS = 1_800_000
/**
 * Same window as `CachedPresetResolver`'s default TTL. Roster reads kick
 * `refreshMesh` but must not stampede `getNodes`.
 */
const MESH_REFRESH_TTL_MS = 30_000
/**
 * Bound for `resolver.list()` and `meshRegistry.getNodes()` while building a
 * fresh roster. A hung read falls back to last-known data. A timed-out mesh
 * read drops its gate (the next call may start another) but must not publish
 * over a newer snapshot. A timed-out preset `list()` stays in flight so the
 * next call does not open a second read. Catalog and slice 4's `list_agents`
 * share this default.
 */
export const ROSTER_READ_BOUND_MS = 2_000

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

/** Coverage inputs shared by delegate_task pre-flight and POST /api/tasks. */
export interface PresetHostContext {
  nodeName: string
  executors?: TaskExecutorRegistry
  meshRegistry?: MeshRegistry
}

/** Why a preset create or delegation must not start, plus any mesh snapshot taken. */
export interface PresetAssessment {
  refusal?: { status: 400 | 409; error: string }
  /** Present when the hosting node was judged from the mesh registry. */
  meshNodes?: MeshNode[]
}

export interface PresetTaskSpecOptions {
  /**
   * When set (including `''`), wins over `preset.model`. Omit to use the preset.
   * A blank string is omitted from the spec rather than stored.
   */
  model?: string
  /**
   * This node, recorded as `spec.meshFrom` on delegation rows.
   * Ignored when `delegation` is false.
   */
  meshFrom?: string
  /**
   * `delegate_task` rows are delegations (`delegation: true`, plus `meshFrom`
   * when this node is known). API creates are not — pass false to omit both.
   * Default true.
   */
  delegation?: boolean
}

/** Resolve when `work` settles, or at `timeoutMs` — and drop the shared gate. */
function raceDeadline(
  work: Promise<void>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout()
      resolve()
    }, timeoutMs)
    timer.unref()
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
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

/** `claude-cli` in an older advertisement covers a `claude-code` preset, and the reverse. */
function advertisedCovers(advertised: string[], harnessId: string): boolean {
  const want = canonicalizeExecutorTarget(harnessId).target
  return advertised.some((item) => canonicalizeExecutorTarget(item).target === want)
}

/**
 * Local rejection text. The executor's own reason (boot's gapOverrides, e.g.
 * "binary not resolvable") wins; a missing executor falls back to the recorded gap.
 */
function localExecutorGap(harnessId: string, executor: HarnessExecutor | undefined): string {
  if (executor && isNotImplementedHarnessExecutor(executor)) {
    return notImplementedHarnessReason(executor) ?? harnessExecutorGap(harnessId)
  }
  return harnessExecutorGap(harnessId)
}

function gapText(preset: AgentPreset, where: string, reason: string): string {
  const harnessId = preset.harnessId ?? 'unknown'
  return `agent "${preset.name}" (${harnessId} on ${where}): ${reason}`
}

/**
 * The `spec` both `delegate_task` and `POST /api/tasks` write for a preset row.
 * One builder so the paths cannot drift.
 */
export function presetTaskSpec(
  preset: AgentPreset,
  opts?: PresetTaskSpecOptions,
): Record<string, unknown> {
  const delegation = opts?.delegation !== false
  const modelSource = opts && 'model' in opts ? opts.model : preset.model
  const trimmedModel = typeof modelSource === 'string' ? modelSource.trim() : ''
  const model = trimmedModel !== '' ? trimmedModel : undefined
  const effort = taskEffort(preset.effort)
  const systemPromptAppend = preset.systemPrompt || undefined
  return {
    ...(delegation ? { delegation: true } : {}),
    presetId: preset.id,
    presetName: preset.name,
    ...(delegation && opts?.meshFrom ? { meshFrom: opts.meshFrom } : {}),
    workingDir: preset.directory,
    sharedLink: preset.sharedLink ?? true,
    // excludeTools is a no-op for harness-session executors (they never
    // consult it). Kept for parity with mesh chat-loop delegations.
    excludeTools: ['delegate_task'],
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(systemPromptAppend ? { systemPromptAppend } : {}),
  }
}

/**
 * Same pre-flight the delegation engine runs.
 * No harness / unimplemented → 400 with the gap text.
 * Hosting node unknown, offline, or unreachable → 409.
 * A local preset with neither an executor registry nor a mesh registry is
 * allowed (single-host sidecar: benefit of the doubt, like an older peer).
 */
export async function assessPresetRun(
  preset: AgentPreset,
  ctx: PresetHostContext,
): Promise<PresetAssessment> {
  if (!preset.harnessId) {
    return {
      refusal: { status: 400, error: `preset "${preset.name}" has no harness configured` },
    }
  }
  if (!preset.node) {
    return {
      refusal: { status: 400, error: `preset "${preset.name}" has no hosting node` },
    }
  }

  const harnessId = preset.harnessId
  const local = preset.node === ctx.nodeName
  if (local && ctx.executors) {
    const executor = ctx.executors.resolve('harness-session', harnessId)
    if (!executor || isNotImplementedHarnessExecutor(executor)) {
      return {
        refusal: {
          status: 400,
          error: gapText(preset, 'this node', localExecutorGap(harnessId, executor)),
        },
      }
    }
    return {}
  }

  // Remote node, or this node with no executor registry (sidecar).
  // No mesh registry: a local preset still runs (nothing else can judge it);
  // a remote one cannot be reached.
  if (!ctx.meshRegistry) {
    if (local) return {}
    return {
      refusal: {
        status: 409,
        error: `no mesh registry; cannot reach node "${preset.node}"`,
      },
    }
  }

  const nodes = await ctx.meshRegistry.getNodes()
  const host = nodes.find((n) => n.name === preset.node && n.status === 'online')
  if (!host) {
    return {
      meshNodes: nodes,
      refusal: {
        status: 409,
        error: `hosting node "${preset.node}" is offline or unknown`,
      },
    }
  }
  const advertised = advertisedHarnesses(host)
  // No harnessExecutors key: an older peer. Benefit of the doubt — create the row.
  if (advertised && !advertisedCovers(advertised, harnessId)) {
    return {
      meshNodes: nodes,
      refusal: {
        status: 400,
        error: gapText(preset, preset.node, harnessExecutorGap(harnessId)),
      },
    }
  }
  return { meshNodes: nodes }
}

export class PresetDelegationEngine {
  private readonly maxChainDepth: number
  private readonly now: () => number
  /** Last mesh snapshot for synchronous roster coverage. Delegation pre-flight re-reads. */
  private meshSnapshot: MeshNode[] = []
  private lastMeshRefreshAt = 0
  /** The getNodes() read itself — not the per-caller timeout wrapper. */
  private meshRefreshInflight: Promise<void> | undefined
  /**
   * Bumped each time a mesh read starts. A read that already timed out keeps
   * its old generation and must not publish over a later snapshot.
   */
  private meshGeneration = 0
  /**
   * The preset `list()` itself, not the per-caller timeout. Left set when a
   * caller times out so the next call does not start another store read.
   */
  private presetReadInflight: Promise<AgentPreset[]> | undefined

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

  /**
   * From resolver.lastKnown(). Synchronous. Kicks a background `list()` and a
   * throttled mesh refresh so presets created after boot show up once the
   * resolver TTL elapses. Remote coverage uses the last mesh snapshot.
   */
  rosterEntries(): PresetRosterEntry[] {
    void this.config.resolver.list()
    void this.refreshMesh()
    return this.config.resolver.lastKnown().map((preset) => this.toRosterEntry(preset))
  }

  /**
   * Presets from a store read that finished within `timeoutMs` (default
   * {@link ROSTER_READ_BOUND_MS}), plus a mesh snapshot no older than that
   * wait. The preset cache is invalidated only when `status().fetchedAt` is
   * older than the roster TTL; inside the TTL this returns `lastKnown()`.
   * On timeout, falls back to `lastKnown()` / the last mesh snapshot. The
   * mesh gate is dropped so a later call can read again; the preset `list()`
   * stays in flight so that call does not open a second read.
   * The catalog and slice 4's `list_agents` use this.
   */
  async rosterEntriesFresh(opts?: { timeoutMs?: number }): Promise<PresetRosterEntry[]> {
    const timeoutMs = opts?.timeoutMs ?? ROSTER_READ_BOUND_MS
    const [, rows] = await Promise.all([
      this.refreshMesh(timeoutMs),
      this.freshPresetRows(timeoutMs),
    ])
    return rows.map((preset) => this.toRosterEntry(preset))
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

  /**
   * `parentTaskId` is set when this call is itself inside a harness task
   * (the mcp-sidecar reads `RIVETOS_TASK_ID`). In-process engines omit it.
   */
  async delegate(
    request: DelegationRequest,
    preset: AgentPreset,
    chainDepth = 0,
    parentTaskId?: string,
  ): Promise<DelegationResult> {
    const depth = chainDepth + 1
    if (depth > this.maxChainDepth) {
      // "mesh" only when the preset actually lives on another node. A
      // same-node chain cap is still a local delegation.
      const remote =
        typeof preset.node === 'string' &&
        preset.node !== '' &&
        preset.node !== this.config.nodeName
      const kind = remote ? 'mesh delegation' : 'delegation'
      return {
        status: 'failed',
        response: `Delegation chain too deep (${String(depth)} > ${String(this.maxChainDepth)}) — refusing ${kind} to ${request.toAgent}`,
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
        // Sidecar chain guard: the parent ros_tasks id when this process was
        // spawned by a delegated harness. Absent for in-process engines.
        ...(parentTaskId ? { parentTaskId } : {}),
        maxAttempts: 1,
        budget: request.timeoutMs ? { maxWallClockMs: request.timeoutMs } : undefined,
        acceptanceCriteria: normalizeCriteria(
          { goal, origin },
          this.config.criteriaPolicy ?? CRITERIA_POLICY_OFF,
        ),
        spec: presetTaskSpec(preset, {
          ...(request.model !== undefined ? { model: request.model } : {}),
          meshFrom: this.config.nodeName,
        }),
      })
      return await settleDelegatedTask({
        store: this.config.taskStore,
        waiter: this.config.waiter,
        rowId: row.id,
        waitMs,
        startTime,
        describe,
        now: this.now,
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
    const assessed = await assessPresetRun(preset, {
      nodeName: this.config.nodeName,
      executors: this.config.executors,
      meshRegistry: this.config.meshRegistry,
    })
    if (assessed.meshNodes) {
      this.meshSnapshot = assessed.meshNodes
      this.lastMeshRefreshAt = this.now()
    }
    if (!assessed.refusal) return undefined
    return { status: 'failed', response: assessed.refusal.error, durationMs: 0 }
  }

  /**
   * `resolver.list()` after invalidate awaits the store. Invalidate only when
   * the cache is older than the roster TTL — a fresh cache is `lastKnown()`.
   * A timed-out `list()` stays `presetReadInflight` so the next caller races
   * that same read instead of opening another one.
   */
  private freshPresetRows(timeoutMs: number): Promise<AgentPreset[]> {
    if (this.presetReadInflight) return this.boundPresetRead(this.presetReadInflight, timeoutMs)
    const status = this.config.resolver.status()
    const stale =
      !status.hasValue ||
      status.fetchedAt === 0 ||
      this.now() - status.fetchedAt >= MESH_REFRESH_TTL_MS
    if (!stale) return Promise.resolve(this.config.resolver.lastKnown())
    this.config.resolver.invalidate()
    const read = this.config.resolver.list().catch(() => this.config.resolver.lastKnown())
    const tracked = read.finally(() => {
      if (this.presetReadInflight === tracked) this.presetReadInflight = undefined
    })
    this.presetReadInflight = tracked
    return this.boundPresetRead(tracked, timeoutMs)
  }

  /** Each caller gets its own deadline. Timeout does not drop `read`. */
  private boundPresetRead(read: Promise<AgentPreset[]>, timeoutMs: number): Promise<AgentPreset[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<AgentPreset[]>((resolve) => {
      timer = setTimeout(() => resolve(this.config.resolver.lastKnown()), timeoutMs)
      timer.unref()
    })
    return Promise.race([read.catch(() => this.config.resolver.lastKnown()), timeout]).finally(
      () => {
        if (timer !== undefined) clearTimeout(timer)
      },
    )
  }

  private refreshMesh(timeoutMs = ROSTER_READ_BOUND_MS): Promise<void> {
    if (!this.config.meshRegistry) return Promise.resolve()
    const fresh =
      this.lastMeshRefreshAt !== 0 && this.now() - this.lastMeshRefreshAt < MESH_REFRESH_TTL_MS
    if (fresh) return Promise.resolve()
    if (!this.meshRefreshInflight) this.meshRefreshInflight = this.startMeshRead()
    const inflight = this.meshRefreshInflight
    return raceDeadline(inflight, timeoutMs, () => {
      // A hung getNodes() must not be the gate for the next roster read.
      if (this.meshRefreshInflight === inflight) this.meshRefreshInflight = undefined
    })
  }

  private startMeshRead(): Promise<void> {
    const registry = this.config.meshRegistry
    if (!registry) return Promise.resolve()
    const gen = ++this.meshGeneration
    const pending = registry
      .getNodes()
      .then((nodes) => {
        // A read that lost the race to a newer one must not clobber that snapshot.
        if (this.meshGeneration !== gen) return
        this.meshSnapshot = nodes
        this.lastMeshRefreshAt = this.now()
      })
      .catch((err: unknown) => {
        log.warn(
          `Could not read mesh registry for preset roster: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        // A dead registry is not retried on every roster read until the TTL passes.
        // A timeout does not stamp — the next call starts a new race.
        // An older generation must not move the freshness timestamp either.
        if (this.meshGeneration !== gen) return
        this.lastMeshRefreshAt = this.now()
      })
      .finally(() => {
        if (this.meshRefreshInflight === pending) this.meshRefreshInflight = undefined
      })
    return pending
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
        return { implemented: false, gap: localExecutorGap(harnessId, executor) }
      }
      return { implemented: true }
    }
    const host = this.meshSnapshot.find((n) => n.name === preset.node && n.status === 'online')
    const advertised = advertisedHarnesses(host)
    if (!advertised) return undefined
    if (!advertisedCovers(advertised, harnessId)) {
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
