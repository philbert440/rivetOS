/**
 * Tasks (4g) — list + detail + create over /api/tasks. Escalation toasts
 * land on /tasks/<id>. Create is first-class in Hub (not chat-only).
 */

import { useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from '@tanstack/react-router'
import type { TaskStatus, TaskWire } from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { Select } from '../components/select.js'
import { useConfirmDialog } from '../components/confirm-dialog.js'
import { criteriaFromLines, taskAgentOptions } from '../lib/task-create.js'

const STATUS_COLORS: Record<TaskStatus, string> = {
  queued: 'text-ink-dim',
  running: 'text-em',
  'awaiting-input': 'text-em',
  completed: 'text-em-dim',
  failed: 'text-red',
  killed: 'text-red',
  timeout: 'text-red',
}

function evalBadge(task: TaskWire): JSX.Element | undefined {
  const verdict = task.eval?.verdict
  if (!verdict) {
    // Evaluable but unevaluated: the verifier is still running (or queued).
    // Without this, a completed-awaiting-eval task reads as "skipped"
    // (#303 review).
    if (task.acceptanceCriteria.length > 0 && task.status === 'completed')
      return <span className="font-mono text-[11px] text-ink-dim">eval:pending</span>
    return undefined
  }
  return <span className={`font-mono text-[11px] ${evalColor(verdict)}`}>eval:{verdict}</span>
}

/** Shared verdict → color so list and detail can't disagree (#303 review). */
function evalColor(verdict: string): string {
  return verdict === 'verified' ? 'text-em' : verdict === 'escalated' ? 'text-red' : 'text-ink-dim'
}

export function TasksPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('')
  const [showCreate, setShowCreate] = useState(false)
  const connected = useGatewayReady()

  const tasks = useQuery({
    queryKey: ['tasks', baseUrl, statusFilter],
    enabled: connected,
    queryFn: ({ signal }) =>
      useConnection
        .getState()
        .gateway.listTasks(
          statusFilter ? { status: statusFilter, limit: 100 } : { limit: 100 },
          signal,
        ),
    refetchInterval: 15_000,
  })

  if (!connected) return <NotConnected />

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-mono text-lg font-semibold text-em">Tasks</h1>
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter}
            title="status filter"
            label="Status"
            onChange={(v) => setStatusFilter(v as TaskStatus | '')}
            options={[
              { value: '', label: 'all statuses' },
              ...Object.keys(STATUS_COLORS).map((s) => ({ value: s, label: s })),
            ]}
          />
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="rounded bg-em-dim px-3 py-1.5 text-sm font-medium text-bg hover:bg-em"
          >
            {showCreate ? 'Close' : 'New task'}
          </button>
        </div>
      </div>

      {showCreate && (
        <TaskCreateForm
          onCreated={(id) => {
            setShowCreate(false)
            void queryClient.invalidateQueries({ queryKey: ['tasks', baseUrl] })
            void navigate({ to: '/tasks/$taskId', params: { taskId: id } })
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {tasks.isError && <div className="font-mono text-sm text-red">{tasks.error.message}</div>}

      <ul className="flex flex-col gap-2">
        {tasks.data?.tasks.map((t) => (
          <li key={t.id}>
            <button
              onClick={() => void navigate({ to: '/tasks/$taskId', params: { taskId: t.id } })}
              className="flex w-full items-center justify-between gap-4 rounded border border-line bg-panel px-4 py-3 text-left hover:border-em"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm">{t.goal}</span>
                <span className="mt-0.5 block font-mono text-[11px] text-ink-dim">
                  {t.agentId} · {t.executor}
                  {t.executorTarget ? `/${t.executorTarget}` : ''} ·{' '}
                  {new Date(t.createdAt).toLocaleString()}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {evalBadge(t)}
                <span className={`font-mono text-xs ${STATUS_COLORS[t.status]}`}>{t.status}</span>
              </span>
            </button>
          </li>
        ))}
        {tasks.data?.tasks.length === 0 && (
          <li className="text-sm text-ink-dim">
            no tasks{statusFilter ? ` (${statusFilter})` : ''}
            {!showCreate && (
              <>
                {' '}
                —{' '}
                <button
                  type="button"
                  className="text-em hover:underline"
                  onClick={() => setShowCreate(true)}
                >
                  create one
                </button>
              </>
            )}
          </li>
        )}
      </ul>
    </div>
  )
}

function TaskCreateForm(props: {
  onCreated: (taskId: string) => void
  onCancel: () => void
}): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const [goal, setGoal] = useState('')
  const [agentId, setAgentId] = useState('')
  const [criteriaText, setCriteriaText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const catalog = useQuery({
    queryKey: ['catalog-agents', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.catalogAgents(signal),
    staleTime: 60_000,
  })

  const agents = taskAgentOptions(catalog.data?.agents ?? [])
  // Seed default agent once catalog loads
  const effectiveAgent = agentId || agents[0]?.value || ''

  const submit = async (): Promise<void> => {
    const g = goal.trim()
    if (!g) {
      setError('goal is required')
      return
    }
    if (!effectiveAgent) {
      setError('pick an agent (catalog empty — is the node connected?)')
      return
    }
    setError(undefined)
    setSubmitting(true)
    try {
      const criteria = criteriaFromLines(criteriaText)
      const res = await useConnection.getState().gateway.createTask({
        goal: g,
        agentId: effectiveAgent,
        acceptanceCriteria: criteria.length > 0 ? criteria : undefined,
        requestedBy: 'rivethub',
      })
      props.onCreated(res.task.id)
    } catch (err) {
      const msg =
        err instanceof GatewayError ? err.message : err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mb-6 rounded border border-line bg-panel p-4">
      <div className="mb-3 font-mono text-xs font-semibold text-em">New task</div>

      <label className="mb-1 block text-xs text-ink-dim">Goal</label>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={3}
        placeholder="What should the agent do?"
        className="mb-3 w-full resize-y rounded border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-em"
        autoFocus
      />

      <label className="mb-1 block text-xs text-ink-dim">Agent</label>
      <div className="mb-3">
        <Select
          value={effectiveAgent}
          title="agent"
          label="Agent"
          disabled={agents.length === 0}
          className="h-9 w-full min-w-0 font-mono text-sm"
          onChange={setAgentId}
          options={
            agents.length === 0
              ? [{ value: '', label: 'loading agents…' }]
              : agents.map((a) => ({ value: a.value, label: a.label }))
          }
        />
      </div>

      <label className="mb-1 block text-xs text-ink-dim">
        Acceptance criteria (optional — one per line)
      </label>
      <textarea
        value={criteriaText}
        onChange={(e) => setCriteriaText(e.target.value)}
        rows={2}
        placeholder="e.g. tests pass&#10;docs updated"
        className="mb-3 w-full resize-y rounded border border-line bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-em"
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !goal.trim()}
          className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em disabled:opacity-40"
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          disabled={submitting}
          className="rounded border border-line px-3 py-2 text-sm text-ink-dim hover:border-em hover:text-ink disabled:opacity-40"
        >
          Cancel
        </button>
        {error && <span className="font-mono text-xs text-red">✗ {error}</span>}
      </div>
    </div>
  )
}

export function TaskDetailPage(): JSX.Element {
  const { taskId } = useParams({ from: '/tasks/$taskId' })
  const baseUrl = useConnection((s) => s.baseUrl)
  const queryClient = useQueryClient()
  const [steerText, setSteerText] = useState('')
  const [acting, setActing] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>()
  const killDialog = useConfirmDialog()

  const connected = useGatewayReady()
  const task = useQuery({
    queryKey: ['task', baseUrl, taskId],
    queryFn: ({ signal }) => useConnection.getState().gateway.getTask(taskId, signal),
    refetchInterval: 10_000,
    enabled: connected,
  })
  if (!connected) return <NotConnected />

  const t = task.data?.task
  const terminal = t && ['completed', 'failed', 'killed', 'timeout'].includes(t.status)

  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (acting) return false
    setActionError(undefined)
    setActing(true)
    try {
      await fn()
      // detail AND list — navigating back must not show pre-action status
      // for a poll interval (#303 review)
      await queryClient.invalidateQueries({ queryKey: ['task', baseUrl, taskId] })
      await queryClient.invalidateQueries({ queryKey: ['tasks', baseUrl] })
      return true
    } catch (err) {
      setActionError((err as Error).message)
      return false
    } finally {
      setActing(false)
    }
  }

  if (task.isError)
    return <div className="p-8 font-mono text-sm text-red">{task.error.message}</div>
  if (!t) return <div className="p-8 text-sm text-ink-dim">loading…</div>

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      {killDialog.element}
      <div className="mb-1 font-mono text-[11px] text-ink-dim">{t.id}</div>
      <h1 className="mb-4 text-lg">{t.goal}</h1>

      <div className="mb-6 overflow-x-auto">
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 rounded border border-line bg-panel p-4 font-mono text-xs sm:grid-cols-3">
        <Cell k="status" v={t.status} className={STATUS_COLORS[t.status]} />
        <Cell k="agent" v={t.agentId} />
        <Cell k="executor" v={`${t.executor}${t.executorTarget ? `/${t.executorTarget}` : ''}`} />
        <Cell k="origin" v={t.origin} />
        <Cell k="created" v={new Date(t.createdAt).toLocaleString()} />
        {t.durationMs !== undefined && (
          <Cell k="duration" v={`${String(Math.round(t.durationMs / 1000))}s`} />
        )}
        {t.eval && <Cell k="eval" v={t.eval.verdict} className={evalColor(t.eval.verdict)} />}
        {!t.eval && t.acceptanceCriteria.length > 0 && t.status === 'completed' && (
          <Cell k="eval" v="pending" className="text-ink-dim" />
        )}
        {t.evalAttempt > 0 && <Cell k="retries" v={String(t.evalAttempt)} />}
      </div>
      </div>

      {t.result && (
        <Section title={`result — ${t.result.verdict}`}>
          <p className="whitespace-pre-wrap text-sm">{t.result.summary}</p>
        </Section>
      )}

      {t.acceptanceCriteria.length > 0 && (
        <Section title="acceptance criteria">
          <ul className="flex flex-col gap-1 text-sm">
            {t.acceptanceCriteria.map((c) => {
              const report = t.eval?.criteriaReport.find((r) => r.id === c.id)
              return (
                <li key={c.id} className="flex gap-2">
                  <span className={report ? (report.met ? 'text-em' : 'text-red') : 'text-ink-dim'}>
                    {report ? (report.met ? '✓' : '✗') : '·'}
                  </span>
                  <span>
                    {c.description}
                    {report?.evidence && (
                      <span className="block font-mono text-[11px] text-ink-dim">
                        {report.evidence}
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {t.error && (
        <Section title="error">
          <p className="whitespace-pre-wrap font-mono text-xs text-red">{t.error}</p>
        </Section>
      )}

      {!terminal && (
        <Section title="actions">
          <div className="flex items-end gap-2">
            <input
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              placeholder="steer message…"
              className="flex-1 rounded border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-em"
            />
            <button
              onClick={() =>
                void act(() => useConnection.getState().gateway.steerTask(taskId, steerText)).then(
                  (ok) => {
                    if (ok) setSteerText('') // keep the draft on failure
                  },
                )
              }
              disabled={!steerText.trim() || acting}
              className="rounded border border-line px-3 py-2 text-sm hover:border-em disabled:opacity-40"
            >
              Steer
            </button>
            <button
              onClick={() => {
                void (async () => {
                  if (await killDialog.confirm(`Kill task ${taskId}?`, { danger: true }))
                    await act(() => useConnection.getState().gateway.killTask(taskId))
                })()
              }}
              disabled={acting}
              className="rounded border border-red/40 px-3 py-2 text-sm text-red hover:border-red disabled:opacity-40"
            >
              Kill
            </button>
          </div>
          {actionError && <div className="mt-2 font-mono text-xs text-red">✗ {actionError}</div>}
        </Section>
      )}
    </div>
  )
}

function Cell(props: { k: string; v: string; className?: string }): JSX.Element {
  return (
    <div>
      <span className="text-ink-dim">{props.k}: </span>
      <span className={props.className}>{props.v}</span>
    </div>
  )
}

function Section(props: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-6">
      <div className="mb-2 font-mono text-xs font-semibold text-em">{props.title}</div>
      {props.children}
    </div>
  )
}
