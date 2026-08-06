/**
 * Workflows hub (slice C) — defs list, contract trigger form, run detail
 * with journal timeline, gate resume, kill, and child-run tree.
 *
 * Live updates: 3s polling on run detail while status is live; 5s on hub list.
 * WS deltas deferred (server does not emit run journal frames yet).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  WorkflowDefSummary,
  WorkflowField,
  WorkflowOpenGate,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { WorkflowContractForm } from '../components/workflow-contract-form.js'
import {
  emptyFormValues,
  formatJournal,
  gateFieldsAsContract,
  isContractError,
  isLiveRunStatus,
  issuesFromGatewayError,
  parseFormValues,
  RUN_STATUS_COLORS,
  RUN_STATUS_LABELS,
  type FieldFormValues,
  type FieldIssues,
} from '../lib/workflow-runs/index.js'

const LIST_POLL_MS = 5_000
const DETAIL_POLL_MS = 3_000
/**
 * Failsafe unlatch for post-202 UI latches (gate resume / recovery): if a
 * detached continuation dies server-side before flipping the run's status,
 * the poll never clears the latch — release it so retry stays possible.
 * Long enough that a healthy resume's status flip (≤ one poll cycle) wins.
 */
const LATCH_FAILSAFE_MS = 30_000

// ---------------------------------------------------------------------------
// Hub list — defs + recent runs
// ---------------------------------------------------------------------------

export function WorkflowsHubPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const navigate = useNavigate()
  const connected = useGatewayReady()

  const defs = useQuery({
    queryKey: ['workflows', baseUrl, token ?? ''],
    enabled: connected,
    queryFn: ({ signal }) => useConnection.getState().gateway.listWorkflows(signal),
    refetchInterval: LIST_POLL_MS,
  })

  const runs = useQuery({
    queryKey: ['workflow-runs', baseUrl, token ?? ''],
    enabled: connected,
    queryFn: ({ signal }) =>
      useConnection.getState().gateway.listWorkflowRuns({ limit: 50 }, signal),
    refetchInterval: LIST_POLL_MS,
  })

  if (!connected) return <NotConnected />

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-mono text-lg font-semibold text-em">Workflows</h1>
        <Link
          to="/workflows/canvas"
          className="font-mono text-[11px] text-ink-dim hover:text-em hover:underline"
        >
          Canvas editor (legacy)
        </Link>
      </div>

      <p className="mb-6 max-w-2xl text-sm text-ink-dim">
        Trigger durable workflows from their input contract. Runs are state — journal timeline,
        human gates, and resume live on the run detail page.
      </p>

      <section className="mb-10">
        <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-dim">
          Definitions
        </h2>
        {defs.isError && (
          <div className="mb-2 font-mono text-sm text-red">{defs.error.message}</div>
        )}
        {defs.isLoading && <p className="text-sm text-ink-dim">loading…</p>}
        <ul className="flex flex-col gap-2">
          {defs.data?.workflows.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() =>
                  void navigate({ to: '/workflows/$workflowId', params: { workflowId: w.id } })
                }
                className="flex w-full items-center justify-between gap-4 rounded border border-line bg-panel px-4 py-3 text-left hover:border-em"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{w.name}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-ink-dim">
                    {w.id} · v{w.version}
                    {w.input.length > 0 ? ` · ${String(w.input.length)} input fields` : ''}
                  </span>
                  {w.description && (
                    <span className="mt-1 block truncate text-xs text-ink-dim">
                      {w.description}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-em">run →</span>
              </button>
            </li>
          ))}
          {defs.data?.workflows.length === 0 && (
            <li className="text-sm text-ink-dim">
              no workflow definitions on this node (check workflows.defs_roots)
            </li>
          )}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-ink-dim">
          Recent runs
        </h2>
        {runs.isError && (
          <div className="mb-2 font-mono text-sm text-red">{runs.error.message}</div>
        )}
        <ul className="flex flex-col gap-2">
          {runs.data?.runs.map((r) => (
            <li key={r.id}>
              <RunListRow
                run={r}
                onClick={() =>
                  void navigate({ to: '/workflows/runs/$runId', params: { runId: r.id } })
                }
              />
            </li>
          ))}
          {runs.data?.runs.length === 0 && <li className="text-sm text-ink-dim">no runs yet</li>}
        </ul>
      </section>
    </div>
  )
}

function RunListRow(props: { run: WorkflowRunSummary; onClick: () => void }): JSX.Element {
  const { run, onClick } = props
  const status = run.status
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-4 rounded border border-line bg-panel px-4 py-3 text-left hover:border-em"
    >
      <span className="min-w-0">
        <span className="block truncate font-mono text-sm">{run.workflowId}</span>
        <span className="mt-0.5 block font-mono text-[11px] text-ink-dim">
          {run.id}
          {run.current ? ` · ${run.current}` : ''}
          {run.startedAt ? ` · ${new Date(run.startedAt).toLocaleString()}` : ''}
          {run.nested ? ' · child' : ''}
        </span>
      </span>
      <StatusChip status={status} />
    </button>
  )
}

function StatusChip(props: { status: string }): JSX.Element {
  const status = props.status as WorkflowRunStatus
  const color = RUN_STATUS_COLORS[status] ?? 'text-ink-dim'
  const label = RUN_STATUS_LABELS[status] ?? props.status
  return <span className={`shrink-0 font-mono text-xs ${color}`}>{label}</span>
}

// ---------------------------------------------------------------------------
// Trigger form
// ---------------------------------------------------------------------------

export function WorkflowTriggerPage(): JSX.Element {
  const { workflowId } = useParams({ from: '/workflows/$workflowId' })
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const navigate = useNavigate()
  const connected = useGatewayReady()

  const def = useQuery({
    queryKey: ['workflow', baseUrl, token ?? '', workflowId],
    enabled: connected && Boolean(workflowId),
    queryFn: ({ signal }) => useConnection.getState().gateway.getWorkflow(workflowId, signal),
  })

  const [values, setValues] = useState<FieldFormValues>({})
  const [issues, setIssues] = useState<FieldIssues>({})
  const [formError, setFormError] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)

  const fields: WorkflowField[] = def.data?.workflow.input ?? []
  const defId = def.data?.workflow.id
  const defVersion = def.data?.workflow.version

  // Seed form when def loads (or workflowId / version changes) — avoid wipe on refetch.
  useEffect(() => {
    if (!def.data?.workflow) return
    setValues(emptyFormValues(def.data.workflow.input))
    setIssues({})
    setFormError(undefined)
    // def.data.workflow.input is replaced with defId/defVersion identity
  }, [workflowId, defId, defVersion])

  const onChange = useCallback((name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }))
    setIssues((prev) => {
      if (!prev[name]) return prev
      const { [name]: _cleared, ...next } = prev
      return next
    })
  }, [])

  const onSubmit = async (): Promise<void> => {
    setFormError(undefined)
    const parsed = parseFormValues(fields, values)
    if (!parsed.ok) {
      setIssues(parsed.issues)
      return
    }
    setSubmitting(true)
    try {
      const result = await useConnection.getState().gateway.startWorkflowRun(workflowId, {
        input: parsed.value,
      })
      void navigate({ to: '/workflows/runs/$runId', params: { runId: result.run.id } })
    } catch (err) {
      if (isContractError(err)) {
        setIssues(issuesFromGatewayError(err))
        setFormError(err instanceof Error ? err.message : 'validation failed')
      } else {
        setFormError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (!connected) return <NotConnected />

  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      <div className="mb-4">
        <Link
          to="/workflows"
          className="font-mono text-[11px] text-ink-dim hover:text-em hover:underline"
        >
          ← workflows
        </Link>
      </div>

      {def.isError && <div className="font-mono text-sm text-red">{def.error.message}</div>}
      {def.isLoading && <p className="text-sm text-ink-dim">loading definition…</p>}

      {def.data && (
        <>
          <h1 className="font-mono text-lg font-semibold text-em">{def.data.workflow.name}</h1>
          <p className="mt-1 font-mono text-[11px] text-ink-dim">
            {def.data.workflow.id} · v{def.data.workflow.version}
          </p>
          {def.data.workflow.description && (
            <p className="mt-2 text-sm text-ink-dim">{def.data.workflow.description}</p>
          )}
          {def.data.workflow.outline && def.data.workflow.outline.length > 0 && (
            <OutlinePreview outline={def.data.workflow.outline} />
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void onSubmit()
            }}
            className="mt-6 flex flex-col gap-4"
          >
            <WorkflowContractForm
              fields={fields}
              values={values}
              issues={issues}
              disabled={submitting}
              onChange={onChange}
              idPrefix="trigger"
            />
            {formError && <p className="font-mono text-sm text-red">{formError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={submitting}
                className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em disabled:opacity-40"
              >
                {submitting ? 'Starting…' : 'Start run'}
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void navigate({ to: '/workflows' })}
                className="rounded border border-line px-4 py-2 text-sm text-ink-dim hover:border-em hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  )
}

function OutlinePreview(props: {
  outline: NonNullable<WorkflowDefSummary['outline']>
}): JSX.Element {
  return (
    <div className="mt-4 rounded border border-line bg-panel px-3 py-2">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
        Outline (display)
      </div>
      <ol className="list-inside list-decimal font-mono text-[11px] text-ink-dim">
        {props.outline.map((s) => (
          <li key={s.id}>
            {s.label ?? s.id}
            {s.kind ? ` · ${s.kind}` : ''}
          </li>
        ))}
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Run detail
// ---------------------------------------------------------------------------

export function WorkflowRunDetailPage(): JSX.Element {
  const { runId } = useParams({ from: '/workflows/runs/$runId' })
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const connected = useGatewayReady()

  const detail = useQuery({
    queryKey: ['workflow-run', baseUrl, token ?? '', runId],
    enabled: connected && Boolean(runId),
    queryFn: ({ signal }) => useConnection.getState().gateway.getWorkflowRun(runId, signal),
    refetchInterval: (q) => {
      const status = q.state.data?.run?.run?.status
      if (isLiveRunStatus(status)) return DETAIL_POLL_MS
      // Detached start: the caseDir materializes a beat after the 202, so a
      // fresh detail page can 404. Keep polling through early errors for a
      // bounded window instead of freezing on a red flash.
      if (!q.state.data && q.state.errorUpdateCount > 0 && q.state.errorUpdateCount <= 10) {
        return DETAIL_POLL_MS
      }
      return false
    },
  })

  const [actionError, setActionError] = useState<string | undefined>()
  const [killing, setKilling] = useState(false)
  const [recovering, setRecovering] = useState(false)

  // Reset the recovery latch when the run leaves paused_human — plus a
  // failsafe unlatch: if a detached resume dies silently server-side after
  // its 202, the run stays paused and the latch must not brick the page.
  const detailStatus = detail.data?.run?.run?.status
  useEffect(() => {
    if (detailStatus !== 'paused_human') setRecovering(false)
  }, [detailStatus])
  useEffect(() => {
    if (!recovering) return
    const t = setTimeout(() => setRecovering(false), LATCH_FAILSAFE_MS)
    return () => clearTimeout(t)
  }, [recovering])

  const payload: WorkflowRunDetail | undefined = detail.data?.run
  const run = payload?.run
  const journalLines = useMemo(
    () => (payload?.journal ? formatJournal(payload.journal) : []),
    [payload?.journal],
  )

  const onKill = async (): Promise<void> => {
    if (!window.confirm(`Kill run “${runId}”? Child runs cascade.`)) return
    setKilling(true)
    setActionError(undefined)
    try {
      await useConnection.getState().gateway.killWorkflowRun(runId)
      await queryClient.invalidateQueries({
        queryKey: ['workflow-run', baseUrl, token ?? '', runId],
      })
      await queryClient.invalidateQueries({ queryKey: ['workflow-runs', baseUrl, token ?? ''] })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setKilling(false)
    }
  }

  if (!connected) return <NotConnected />

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/workflows"
          className="font-mono text-[11px] text-ink-dim hover:text-em hover:underline"
        >
          ← workflows
        </Link>
        {run && isLiveRunStatus(run.status) && (
          <button
            type="button"
            disabled={killing}
            onClick={() => void onKill()}
            className="rounded border border-red/50 px-3 py-1 font-mono text-xs text-red hover:bg-red/10 disabled:opacity-40"
          >
            {killing ? 'Killing…' : 'Kill run'}
          </button>
        )}
      </div>

      {detail.isError && <div className="font-mono text-sm text-red">{detail.error.message}</div>}
      {detail.isLoading && <p className="text-sm text-ink-dim">loading run…</p>}
      {actionError && <p className="mb-3 font-mono text-sm text-red">{actionError}</p>}

      {run && payload && (
        <>
          <header className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
            <div className="min-w-0">
              <h1 className="truncate font-mono text-lg font-semibold text-em">{run.workflowId}</h1>
              <p className="mt-1 font-mono text-[11px] text-ink-dim">{run.id}</p>
              {run.current && (
                <p className="mt-1 font-mono text-xs text-ink">current: {run.current}</p>
              )}
              {run.error && <p className="mt-2 font-mono text-xs text-red">{run.error}</p>}
            </div>
            <StatusChip status={run.status} />
          </header>

          {run.status === 'paused_human' && payload.openGate && (
            <GateCard
              runId={runId}
              gate={payload.openGate}
              onResumed={async () => {
                await queryClient.invalidateQueries({
                  queryKey: ['workflow-run', baseUrl, token ?? '', runId],
                })
              }}
            />
          )}

          {run.status === 'paused_human' && !payload.openGate && (
            // Crash window: the gate was answered but the run never continued
            // (paused_human with no open gate). resumeRun recovers this state.
            <section className="mb-6 rounded border border-line bg-panel p-4">
              <p className="mb-3 font-mono text-xs text-ink">
                This run is paused but its gate is already answered — it likely crashed mid-resume
                and can be recovered.
              </p>
              <button
                type="button"
                disabled={recovering}
                onClick={() => {
                  void (async () => {
                    setRecovering(true)
                    setActionError(undefined)
                    try {
                      await useConnection
                        .getState()
                        .gateway.resumeWorkflowRun(runId, { gateResponse: {} })
                      await queryClient.invalidateQueries({
                        queryKey: ['workflow-run', baseUrl, token ?? '', runId],
                      })
                    } catch (err) {
                      // A rejected request means no detached resume is in
                      // flight (pre-validation + engine lock) — unlatch so
                      // the user can retry instead of bricking the button.
                      setRecovering(false)
                      setActionError(err instanceof Error ? err.message : String(err))
                    }
                    // On success: stay disabled until the poll moves the run
                    // off paused — a second detached resume would race the first.
                  })()
                }}
                className="rounded border border-em/50 px-3 py-1 font-mono text-xs text-em hover:bg-em/10 disabled:opacity-40"
              >
                {recovering ? 'Recovering…' : 'Recover run'}
              </button>
            </section>
          )}

          {payload.children.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-dim">
                Child runs
              </h2>
              <ul className="flex flex-col gap-1">
                {payload.children.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() =>
                        void navigate({
                          to: '/workflows/runs/$runId',
                          params: { runId: c.id },
                        })
                      }
                      className="flex w-full items-center justify-between gap-3 rounded border border-line bg-panel px-3 py-2 text-left hover:border-em"
                    >
                      <span className="min-w-0 truncate font-mono text-xs">
                        {c.workflowId} · {c.id}
                      </span>
                      <StatusChip status={c.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {run.output && Object.keys(run.output).length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-dim">
                Output
              </h2>
              <pre className="overflow-x-auto rounded border border-line bg-panel-2 p-3 font-mono text-[11px] text-ink">
                {JSON.stringify(run.output, null, 2)}
              </pre>
            </section>
          )}

          <section>
            <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-dim">
              Journal
              {isLiveRunStatus(run.status) && (
                <span className="ml-2 font-normal normal-case text-ink-dim/70">
                  · live · 3s poll
                </span>
              )}
            </h2>
            <ol className="flex flex-col gap-0 border-l border-line pl-4">
              {journalLines.map((line) => (
                <li key={line.key} className="relative mb-3 pl-1">
                  <span
                    className={`absolute -left-[1.15rem] top-1.5 size-2 rounded-full ${
                      line.severity === 'error'
                        ? 'bg-red'
                        : line.severity === 'em'
                          ? 'bg-em'
                          : line.severity === 'warn'
                            ? 'bg-em-dim/60'
                            : 'bg-line'
                    }`}
                  />
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-[10px] text-ink-dim">
                      {line.ts ? new Date(line.ts).toLocaleTimeString() : '—'}
                    </span>
                    <span
                      className={`text-sm ${
                        line.severity === 'error'
                          ? 'text-red'
                          : line.severity === 'em'
                            ? 'text-em'
                            : 'text-ink'
                      }`}
                    >
                      {line.summary}
                    </span>
                  </div>
                  {line.detail && (
                    <pre className="mt-0.5 max-h-24 overflow-auto font-mono text-[11px] text-ink-dim whitespace-pre-wrap">
                      {line.detail}
                    </pre>
                  )}
                </li>
              ))}
              {journalLines.length === 0 && (
                <li className="text-sm text-ink-dim">no journal entries yet</li>
              )}
            </ol>
          </section>
        </>
      )}
    </div>
  )
}

function GateCard(props: {
  runId: string
  gate: WorkflowOpenGate
  onResumed: () => void | Promise<void>
}): JSX.Element {
  // Stabilize identity across poll refreshes (new array refs every 3s).
  const gateKey = `${props.gate.stepId}#${String(props.gate.seq)}:${JSON.stringify(props.gate.fields)}`
  const fields = useMemo(() => gateFieldsAsContract(props.gate.fields), [gateKey])
  const [values, setValues] = useState<FieldFormValues>(() => emptyFormValues(fields))
  const [issues, setIssues] = useState<FieldIssues>({})
  const [error, setError] = useState<string | undefined>()
  const [submitting, setSubmitting] = useState(false)
  // After a detached 202 the run still polls as paused for up to one cycle —
  // keep the form latched so a second click can't race the first resume.
  // Failsafe: a silently-dead detached resume leaves the gate open forever;
  // release the latch after LATCH_FAILSAFE_MS so retry stays possible.
  const [accepted, setAccepted] = useState(false)
  useEffect(() => {
    if (!accepted) return
    const t = setTimeout(() => setAccepted(false), LATCH_FAILSAFE_MS)
    return () => clearTimeout(t)
  }, [accepted])

  // Re-seed only when the open gate identity actually changes (tracked via
  // lastSeededKey so a 422 on the same gate never wipes its own issues), and
  // never while a submit is in flight; if a gate change arrives mid-flight,
  // the `submitting` dep re-runs this effect once the flight ends.
  const submittingRef = useRef(false)
  const lastSeededKey = useRef<string>()
  useEffect(() => {
    if (submittingRef.current) return
    if (lastSeededKey.current === gateKey) return
    lastSeededKey.current = gateKey
    setValues(emptyFormValues(fields))
    setIssues({})
    setError(undefined)
    setAccepted(false)
  }, [gateKey, fields, submitting])

  const onChange = (name: string, value: string): void => {
    setValues((v) => ({ ...v, [name]: value }))
    setIssues((prev) => {
      if (!prev[name]) return prev
      const { [name]: _cleared, ...next } = prev
      return next
    })
  }

  const onSubmit = async (): Promise<void> => {
    setError(undefined)
    const parsed = parseFormValues(fields, values)
    if (!parsed.ok) {
      setIssues(parsed.issues)
      return
    }
    setSubmitting(true)
    submittingRef.current = true
    try {
      await useConnection.getState().gateway.resumeWorkflowRun(props.runId, {
        gateResponse: parsed.value,
      })
      setAccepted(true)
      await props.onResumed()
    } catch (err) {
      if (isContractError(err)) {
        setIssues(issuesFromGatewayError(err))
        setError(err instanceof Error ? err.message : 'validation failed')
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <section className="mb-6 rounded-lg border border-em/40 bg-panel px-4 py-3 shadow-lg shadow-bg/20">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-mono text-xs font-semibold text-em">Human gate · {props.gate.label}</h2>
        <span className="font-mono text-[10px] text-ink-dim">{props.gate.stepId}</span>
      </div>
      {props.gate.prompt && <p className="mb-3 text-sm text-ink">{props.gate.prompt}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void onSubmit()
        }}
        className="flex flex-col gap-3"
      >
        <WorkflowContractForm
          fields={fields}
          values={values}
          issues={issues}
          disabled={submitting || accepted}
          onChange={onChange}
          idPrefix="gate"
        />
        {error && <p className="font-mono text-sm text-red">{error}</p>}
        <button
          type="submit"
          disabled={submitting || accepted}
          className="self-start rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em disabled:opacity-40"
        >
          {accepted ? 'Resumed — continuing…' : submitting ? 'Resuming…' : 'Resume'}
        </button>
      </form>
    </section>
  )
}
