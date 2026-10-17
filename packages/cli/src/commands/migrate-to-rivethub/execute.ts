/** Print or run a migration / rollback plan. Returns the process exit code. */

import type { Host } from './host.js'
import type { Plan, Step } from './plan.js'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_REFUSED = 2

export const ROLLBACK_HINT = 'rivetos migrate-to-rivethub --rollback'

export function printPlan(plan: Plan, host: Host, indent = '  '): void {
  host.log(`${indent}Plan (${String(plan.steps.length)} steps):`)
  plan.steps.forEach((step, i) => {
    host.log(`${indent}  ${String(i + 1)}. ${step.title}`)
    for (const cmd of step.commands) host.log(`${indent}       $ ${cmd}`)
  })
  for (const note of plan.notes) host.log(`${indent}ℹ️  ${note}`)
}

async function runStep(
  step: Step,
  host: Host,
  label: string,
  signal?: AbortSignal,
): Promise<Error | undefined> {
  host.log(`  ${label} ${step.title}`)
  try {
    const detail = await step.run(host, signal)
    host.log(`    ✅ ${detail ?? 'done'}`)
    return undefined
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    host.error(`    ❌ ${error.message}`)
    return error
  }
}

async function recover(plan: Plan, host: Host): Promise<boolean> {
  host.log('')
  host.log('  ↩️  Putting the RivetOS runtime back (the database adoption, if any, stays):')
  let ok = true
  for (const step of plan.recovery) {
    if ((await runStep(step, host, '•')) !== undefined) ok = false
  }
  return ok
}

export async function executePlan(plan: Plan, host: Host, dryRun: boolean): Promise<number> {
  const what = plan.mode === 'migrate' ? 'Migration to RivetHub' : 'Rollback to RivetOS'
  if (plan.done) {
    host.log(`  ✅ ${plan.done}`)
    return EXIT_OK
  }
  if (plan.refusals.length > 0) {
    host.error(`  ❌ ${what} refused by the preflight:`)
    for (const r of plan.refusals) host.error(`     • ${r}`)
    if (dryRun) printPlan(plan, host)
    return EXIT_REFUSED
  }
  if (dryRun) {
    host.log('  ✅ Preflight passed.')
    printPlan(plan, host)
    host.log('  (dry run — nothing was changed)')
    return EXIT_OK
  }

  // From the first switch step on, an interrupt (Ctrl-C, a dropped SSH
  // session, systemctl stop) must not leave the node half switched: the
  // signal is trapped, the running step finishes (or a wait is cut short),
  // and the recovery runs once before the process exits.
  const abort = new AbortController()
  let interrupted: string | undefined
  let release: (() => void) | undefined
  const trap = (): void => {
    release ??= host.onInterrupt((signal) => {
      if (interrupted) {
        host.error(`  ⚠️  ${signal} again — still finishing up, please wait.`)
        return
      }
      interrupted = signal
      host.error(
        `  ⚠️  ${signal}: finishing the current step, then ${plan.mode === 'migrate' ? 'putting RivetOS back' : 'stopping'}.`,
      )
      abort.abort()
    })
  }
  try {
    return await runSteps(plan, host, what, trap, abort.signal, () => interrupted)
  } finally {
    release?.()
  }
}

async function runSteps(
  plan: Plan,
  host: Host,
  what: string,
  trap: () => void,
  signal: AbortSignal,
  interrupted: () => string | undefined,
): Promise<number> {
  const total = plan.steps.length
  for (let i = 0; i < total; i++) {
    const step = plan.steps[i]
    if (step.phase === 'switch') trap()
    const failed = await runStep(step, host, `[${String(i + 1)}/${String(total)}]`, signal)
    const sig = interrupted()
    if (!failed && sig && i < total - 1) {
      if (plan.mode === 'rollback') {
        host.error(
          `  ❌ Rollback interrupted (${sig}) after "${step.title}". Re-run: ${ROLLBACK_HINT}`,
        )
        return EXIT_FAILED
      }
      const restored = await recover(plan, host)
      host.error(
        restored
          ? `  ❌ Migration interrupted (${sig}); the RivetOS runtime is back.`
          : `  ❌ Migration interrupted (${sig}) and the automatic recovery did not finish. Run: ${ROLLBACK_HINT}`,
      )
      return EXIT_FAILED
    }
    if (!failed) continue

    if (step.refuseOnFailure) {
      host.error(`  ❌ ${what} refused at "${step.title}". The running node was not changed.`)
      return EXIT_REFUSED
    }
    if (plan.mode === 'rollback') {
      host.error(`  ❌ Rollback stopped at "${step.title}". Fix the cause and re-run it;`)
      host.error('     every rollback step checks what is left to undo.')
      return EXIT_FAILED
    }
    if (step.phase === 'prepare') {
      host.error(`  ❌ Stopped before changing the running node ("${step.title}").`)
      return EXIT_FAILED
    }
    const restored = await recover(plan, host)
    host.error(
      restored
        ? '  ❌ Migration failed; the RivetOS runtime is back. Nothing else to undo.'
        : `  ❌ Migration failed and the automatic recovery did not finish. Run: ${ROLLBACK_HINT}`,
    )
    return EXIT_FAILED
  }

  host.log('')
  for (const note of plan.notes) host.log(`  ℹ️  ${note}`)
  host.log(
    plan.mode === 'migrate'
      ? `  ✅ This node runs RivetHub. To go back: ${ROLLBACK_HINT}`
      : '  ✅ This node runs RivetOS again.',
  )
  return EXIT_OK
}
