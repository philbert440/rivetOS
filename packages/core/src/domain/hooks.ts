/**
 * HookPipeline — composable async middleware for lifecycle events.
 *
 * Pure domain logic. No I/O. Works with interfaces only.
 *
 * Design:
 * - Hooks are sorted by priority (lower = first, default 50)
 * - Each hook receives the context object and can mutate it
 * - Hooks can return 'abort' (hard stop) or 'skip' (soft stop)
 * - Error handling per-hook: continue (log & proceed), abort, or retry
 * - Agent/tool filters narrow which hooks fire
 *
 * The pipeline is the single mechanism powering fallbacks, safety gates,
 * auto-actions, session hooks, and eventually dynamic routing.
 */

import type {
  HookContext,
  HookEventName,
  HookRegistration,
  HookPipeline as IHookPipeline,
  HookPipelineResult,
  HookHandlerFn,
} from '@rivetos/types'

// ---------------------------------------------------------------------------
// Logger interface — injected, not imported (pure domain)
// ---------------------------------------------------------------------------

export interface HookLogger {
  debug(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

const nullLogger: HookLogger = {
  debug() {},
  warn() {},
  error() {},
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class HookPipelineImpl implements IHookPipeline {
  private hooks: Map<string, HookRegistration> = new Map()
  private sorted: Map<HookEventName, HookRegistration[]> = new Map()
  private dirty = true
  private log: HookLogger

  constructor(logger?: HookLogger) {
    this.log = logger ?? nullLogger
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  register<T extends HookContext>(hook: HookRegistration<T>): void {
    if (this.hooks.has(hook.id)) {
      this.log.warn(`Hook "${hook.id}" already registered — replacing`)
    }
    // Normalize defaults
    const normalized: HookRegistration = {
      ...hook,
      priority: hook.priority ?? 50,
      onError: hook.onError ?? 'continue',
      enabled: hook.enabled ?? true,
      handler: hook.handler as HookHandlerFn,
    }
    this.hooks.set(hook.id, normalized)
    this.dirty = true
  }

  unregister(hookId: string): boolean {
    const deleted = this.hooks.delete(hookId)
    if (deleted) this.dirty = true
    return deleted
  }

  clear(): void {
    this.hooks.clear()
    this.sorted.clear()
    this.dirty = false
  }

  getHooks(event?: HookEventName): HookRegistration[] {
    if (event) {
      this.rebuildIfDirty()
      return this.sorted.get(event) ?? []
    }
    return [...this.hooks.values()]
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  async run<T extends HookContext>(ctx: T): Promise<HookPipelineResult<T>> {
    this.rebuildIfDirty()

    const hooks = this.sorted.get(ctx.event) ?? []
    const result: HookPipelineResult<T> = {
      context: ctx,
      aborted: false,
      skipped: false,
      errors: [],
      ran: [],
    }

    for (const hook of hooks) {
      // Skip disabled hooks
      if (!hook.enabled) continue

      // Agent filter
      if (hook.agentFilter?.length && ctx.agentId) {
        if (!hook.agentFilter.includes(ctx.agentId)) continue
      }

      // Tool filter (only applies to tool:before/after)
      if (hook.toolFilter?.length && 'toolName' in ctx) {
        if (!hook.toolFilter.includes((ctx as any).toolName)) continue
      }

      // Execute
      try {
        this.log.debug(`Hook "${hook.id}" running for ${ctx.event}`)
        const signal = await hook.handler(ctx)
        result.ran.push(hook.id)

        if (signal === 'abort') {
          this.log.debug(`Hook "${hook.id}" aborted pipeline`)
          result.aborted = true
          break
        }

        if (signal === 'skip') {
          this.log.debug(`Hook "${hook.id}" skipped remaining hooks`)
          result.skipped = true
          break
        }
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err))
        this.log.error(`Hook "${hook.id}" threw: ${error.message}`)

        switch (hook.onError) {
          case 'abort':
            result.errors.push({ hookId: hook.id, error })
            result.aborted = true
            return result

          case 'retry':
            // Retry once
            try {
              this.log.debug(`Hook "${hook.id}" retrying...`)
              const retrySignal = await hook.handler(ctx)
              result.ran.push(hook.id)
              if (retrySignal === 'abort') {
                result.aborted = true
                return result
              }
              if (retrySignal === 'skip') {
                result.skipped = true
                return result
              }
            } catch (retryErr: any) {
              const retryError = retryErr instanceof Error ? retryErr : new Error(String(retryErr))
              this.log.error(`Hook "${hook.id}" retry failed: ${retryError.message}`)
              result.errors.push({ hookId: hook.id, error: retryError })
              // After retry failure, continue (don't cascade)
            }
            break

          case 'continue':
          default:
            result.errors.push({ hookId: hook.id, error })
            result.ran.push(hook.id)
            // Continue to next hook
            break
        }
      }
    }

    return result
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private rebuildIfDirty(): void {
    if (!this.dirty) return

    this.sorted.clear()
    const all = [...this.hooks.values()]

    for (const hook of all) {
      let list = this.sorted.get(hook.event)
      if (!list) {
        list = []
        this.sorted.set(hook.event, list)
      }
      list.push(hook)
    }

    // Sort each event's hooks by priority
    for (const [, list] of this.sorted) {
      list.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
    }

    this.dirty = false
  }
}
