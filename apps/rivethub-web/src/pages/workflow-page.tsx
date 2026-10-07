/**
 * Workflow page — one def, three tabs: Overview (contract, health, its runs),
 * Canvas (flows editor), Files (file tree + workflow.yaml form). Run is a
 * side sheet reachable from every tab. The tab lives in the URL (`?view=`); the dirty
 * guard's router blocker therefore asks before a tab switch drops edits.
 */

import { useState, type JSX, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { WorkflowDefSummary, WorkflowField } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { useIsNarrow } from '../lib/use-narrow.js'
import { useWorkflowDirtyGuard } from '../lib/workflow-dirty-guard.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { SegmentedControl } from '../components/segmented-control.js'
import { WorkflowEditPanel } from '../components/workflow-edit-panel.js'
import { FlowsAuthor } from '../components/flows-author.js'
import { RunListRow, RunWorkflowSheet, StatusChip } from '../components/workflow-run-ui.js'
import {
  relativeTime,
  RUN_STATUS_FILTERS,
  runDisplayName,
  type RunStatusFilter,
} from '../lib/workflow-runs/index.js'

export type WorkflowTab = 'overview' | 'canvas' | 'files'

const POLL_MS = 5_000

const STATUS_FILTER_OPTIONS: { value: RunStatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'live', label: 'Live' },
  { value: 'failed', label: 'Failed' },
  { value: 'done', label: 'Done' },
]

export function WorkflowPage(): JSX.Element {
  const { workflowId } = useParams({ from: '/workflows/$workflowId' })
  const search = useSearch({ from: '/workflows/$workflowId' })
  const baseUrl = useConnection((s) => s.baseUrl)
  const navigate = useNavigate()
  const connected = useGatewayReady()
  const narrow = useIsNarrow()
  const tab: WorkflowTab = search.view ?? 'overview'
  // Local, not URL: opening the sheet must not be a navigation, or the
  // dirty guard would ask to discard canvas edits just to start a run.
  const [runOpen, setRunOpen] = useState(search.run === true)
  const { markDirty, confirmDiscard, element: discardDialogElement } = useWorkflowDirtyGuard()

  const def = useQuery({
    queryKey: ['workflow', baseUrl, workflowId],
    enabled: connected && Boolean(workflowId),
    queryFn: ({ signal }) => useConnection.getState().gateway.getWorkflow(workflowId, signal),
  })
  const defs = useQuery({
    queryKey: ['workflows', baseUrl],
    enabled: connected,
    queryFn: ({ signal }) => useConnection.getState().gateway.listWorkflows(signal),
    refetchInterval: POLL_MS,
  })
  const workflowOptions = (defs.data?.workflows ?? []).map((w) => ({ value: w.id, label: w.name }))
  const stats = defs.data?.workflows.find((w) => w.id === workflowId)?.stats

  if (!connected) return <NotConnected />

  const wf = def.data?.workflow
  const editPath = wf?.editPath
  const setTab = (next: WorkflowTab): void => {
    if (next === tab) return
    void navigate({
      to: '/workflows/$workflowId',
      params: { workflowId },
      search: next === 'overview' ? {} : { view: next },
    })
  }

  return (
    <div
      className={
        narrow ? 'fixed bottom-0 right-0 top-12 flex flex-col bg-bg' : 'fixed flex flex-col bg-bg'
      }
      style={
        narrow
          ? { left: 'var(--hub-rail, 14rem)' }
          : {
              left: 'var(--hub-rail, 14rem)',
              top: 'var(--hub-top, 0px)',
              right: 'var(--hub-inset, 0px)',
              bottom: 'var(--hub-inset, 0px)',
            }
      }
    >
      {discardDialogElement}
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        {/* No click handler: leaving is a route change, and the dirty guard's
            router blocker asks about unsaved edits for every route change. */}
        <Link
          to="/workflows"
          className="font-mono text-[11px] text-ink-dim hover:text-em hover:underline"
        >
          ← workflows
        </Link>
        <div className="min-w-0">
          <h1 className="truncate font-mono text-base font-semibold text-em">
            {wf?.name ?? workflowId}
          </h1>
          {wf && (
            <p className="font-mono text-[11px] text-ink-dim">
              {wf.id} · v{wf.version}
            </p>
          )}
        </div>
        <SegmentedControl
          ariaLabel="Workflow view"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            {
              value: 'canvas',
              label: 'Canvas',
              disabled: !wf || (!editPath && (wf.outline?.length ?? 0) === 0),
              title:
                wf && !editPath && (wf.outline?.length ?? 0) === 0
                  ? 'No outline to draw, and the def is outside the files root'
                  : undefined,
            },
            {
              value: 'files',
              label: 'Files',
              disabled: !editPath,
              title: editPath ? undefined : 'Def is outside the files root — files are read-only',
            },
          ]}
        />
        <span className="ml-auto" />
        <button
          type="button"
          disabled={!wf}
          onClick={() => setRunOpen(true)}
          className="rounded bg-em-dim px-4 py-1.5 font-mono text-xs font-medium text-bg hover:bg-em disabled:opacity-40"
        >
          Run
        </button>
      </header>

      {def.isError && <p className="p-4 font-mono text-sm text-red">{def.error.message}</p>}
      {def.isLoading && <p className="p-4 text-sm text-ink-dim">loading definition…</p>}

      {wf && tab === 'overview' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkflowOverview def={wf} stats={stats} onRun={() => setRunOpen(true)} />
        </div>
      )}

      {wf && tab === 'canvas' && (
        <div className="min-h-0 flex-1">
          <FlowsAuthor
            workflowId={workflowId}
            editPath={editPath}
            name={wf.name}
            version={wf.version}
            description={wf.description}
            outline={wf.outline}
            input={wf.input}
            output={wf.output}
            workflowOptions={workflowOptions}
            onDirtyChange={markDirty}
            onWorkflowChange={(id) => {
              void (async () => {
                if (!(await confirmDiscard())) return
                void navigate({
                  to: '/workflows/$workflowId',
                  params: { workflowId: id },
                  search: { view: 'canvas' },
                })
              })()
            }}
          />
        </div>
      )}

      {wf && tab === 'files' && editPath && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
            {/* key: remount per def — router param navigation reuses this component,
                and the panel seeds `selected` in a mount-only initializer. */}
            <WorkflowEditPanel
              key={editPath}
              workflowId={workflowId}
              editPath={editPath}
              onDirtyChange={markDirty}
            />
          </div>
        </div>
      )}

      {wf && <RunWorkflowSheet def={wf} open={runOpen} onOpenChange={setRunOpen} />}
    </div>
  )
}

function WorkflowOverview(props: {
  def: WorkflowDefSummary
  stats?: WorkflowDefSummary['stats']
  onRun: () => void
}): JSX.Element {
  const { def, stats, onRun } = props
  const baseUrl = useConnection((s) => s.baseUrl)
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState<RunStatusFilter>('all')
  const query = { workflowId: def.id, status: RUN_STATUS_FILTERS[statusFilter], limit: 50 }
  const runs = useQuery({
    queryKey: ['workflow-runs', baseUrl, query],
    queryFn: ({ signal }) => useConnection.getState().gateway.listWorkflowRuns(query, signal),
    refetchInterval: POLL_MS,
    placeholderData: (prev) => prev,
  })
  const names = new Map([[def.id, def.name]])
  const last = stats?.lastRun

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-6 md:px-6">
      {def.description && <p className="max-w-2xl text-sm text-ink-dim">{def.description}</p>}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Last run">
          {last ? (
            <button
              type="button"
              onClick={() =>
                void navigate({ to: '/workflows/runs/$runId', params: { runId: last.id } })
              }
              className="flex items-baseline gap-2 hover:underline"
            >
              <StatusChip status={last.status} />
              <span className="font-mono text-[11px] text-ink-dim">
                {relativeTime(last.startedAt)}
              </span>
            </button>
          ) : (
            <span className="text-ink-dim">never</span>
          )}
        </Stat>
        <Stat label="Runs · 7d">{String(stats?.recent ?? 0)}</Stat>
        <Stat label="Failed · 7d">
          <span className={stats?.recentFailed ? 'text-red' : undefined}>
            {String(stats?.recentFailed ?? 0)}
          </span>
        </Stat>
        <Stat label="Waiting on you">
          <span className={stats?.waiting ? 'text-em' : undefined}>
            {String(stats?.waiting ?? 0)}
          </span>
        </Stat>
      </dl>

      <div className="grid gap-6 md:grid-cols-2">
        <ContractList title="Inputs" fields={def.input} empty="No inputs — runs start empty." />
        <ContractList title="Outputs" fields={def.output} empty="No declared outputs." />
      </div>
      {def.runLabel && (
        <p className="-mt-4 font-mono text-[11px] text-ink-dim">
          Runs are named <span className="text-ink">{def.runLabel}</span>
        </p>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wide text-ink-dim">
            Runs
          </h2>
          <SegmentedControl
            ariaLabel="Run status filter"
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_FILTER_OPTIONS}
          />
        </div>
        {runs.isError && <p className="mb-2 font-mono text-sm text-red">{runs.error.message}</p>}
        {runs.data?.runs.length === 0 ? (
          <div className="rounded border border-dashed border-line px-4 py-6 text-center">
            <p className="text-sm text-ink-dim">
              {statusFilter === 'all' ? 'This workflow has not run yet.' : 'No matching runs.'}
            </p>
            {statusFilter === 'all' && (
              <button
                type="button"
                onClick={onRun}
                className="mt-3 rounded bg-em-dim px-4 py-1.5 font-mono text-xs font-medium text-bg hover:bg-em"
              >
                Run it
              </button>
            )}
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded border border-line bg-panel">
            {runs.data?.runs.map((r) => (
              <li key={r.id}>
                <RunListRow
                  run={r}
                  name={runDisplayName(r, names)}
                  onClick={() =>
                    void navigate({ to: '/workflows/runs/$runId', params: { runId: r.id } })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Stat(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="rounded border border-line bg-panel px-3 py-2">
      <dt className="font-mono text-[10px] uppercase tracking-wide text-ink-dim">{props.label}</dt>
      <dd className="mt-1 font-mono text-sm text-ink">{props.children}</dd>
    </div>
  )
}

function ContractList(props: {
  title: string
  fields: WorkflowField[]
  empty: string
}): JSX.Element {
  return (
    <section>
      <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-dim">
        {props.title}
      </h2>
      {props.fields.length === 0 ? (
        <p className="text-sm text-ink-dim">{props.empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {props.fields.map((f) => (
            <li key={f.name} className="rounded border border-line bg-panel px-3 py-2">
              <div className="flex items-baseline gap-2 font-mono text-xs">
                <span className="text-ink">{f.name}</span>
                <span className="text-ink-dim">{f.type}</span>
                {f.required !== false && <span className="text-red">required</span>}
              </div>
              {f.description && <p className="mt-1 text-xs text-ink-dim">{f.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
