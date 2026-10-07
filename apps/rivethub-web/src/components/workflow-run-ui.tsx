/**
 * Workflow run UI shared by the hub home and the workflow page: run rows,
 * status chip, and the Run side sheet (run name + input contract form).
 */

import { useCallback, useState, type JSX } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useNavigate } from '@tanstack/react-router'
import type { WorkflowDefSummary, WorkflowRunStatus, WorkflowRunSummary } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { WorkflowContractForm } from './workflow-contract-form.js'
import {
  emptyFormValues,
  formatRunDuration,
  isContractError,
  issuesFromGatewayError,
  parseFormValues,
  previewRunLabel,
  relativeTime,
  RUN_STATUS_COLORS,
  RUN_STATUS_LABELS,
  type FieldFormValues,
  type FieldIssues,
} from '../lib/workflow-runs/index.js'

export function RunListRow(props: {
  run: WorkflowRunSummary
  name: string
  onClick: () => void
}): JSX.Element {
  const { run, name, onClick } = props
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 text-left hover:bg-panel-2 sm:grid-cols-[minmax(0,1fr)_8rem_6rem_5rem_7rem]"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm">{name}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-dim">
          {run.label ? `${run.workflowId} · ` : ''}
          {run.id.slice(0, 8)}
          {run.current ? ` · ${run.current}` : ''}
        </span>
      </span>
      <span className="hidden truncate font-mono text-[11px] text-ink-dim sm:block">
        {run.workflowId}
      </span>
      <span
        className="hidden font-mono text-[11px] text-ink-dim sm:block"
        title={run.startedAt ? new Date(run.startedAt).toLocaleString() : undefined}
      >
        {relativeTime(run.startedAt)}
      </span>
      <span className="hidden font-mono text-[11px] text-ink-dim sm:block">
        {formatRunDuration(run.startedAt, run.finishedAt)}
      </span>
      <span className="text-right">
        <StatusChip status={run.status} />
      </span>
    </button>
  )
}

export function StatusChip(props: { status: string }): JSX.Element {
  const status = props.status as WorkflowRunStatus
  const color =
    (RUN_STATUS_COLORS as Partial<Record<WorkflowRunStatus, string>>)[status] ?? 'text-ink-dim'
  const label =
    (RUN_STATUS_LABELS as Partial<Record<WorkflowRunStatus, string>>)[status] ?? props.status
  return <span className={`shrink-0 font-mono text-xs ${color}`}>{label}</span>
}

/** Optional run label; placeholder previews the def's `runLabel` template. */
export function RunNameField(props: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-xs text-ink">
        Run name <span className="text-ink-dim">(optional)</span>
      </span>
      <input
        type="text"
        value={props.value}
        maxLength={120}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder ?? 'e.g. rivetOS#123 login fix'}
        className="w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim focus:border-em"
      />
    </label>
  )
}

/**
 * Run a workflow from any tab: right-hand sheet with the run name and the
 * def's input contract. Starting navigates to the live run page. Content
 * unmounts on close, so each open starts from an empty form.
 */
export function RunWorkflowSheet(props: {
  def: WorkflowDefSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const [submitting, setSubmitting] = useState(false)
  return (
    <Dialog.Root open={props.open} onOpenChange={(o) => !submitting && props.onOpenChange(o)}>
      {props.open && (
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/60" />
          <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(30rem,100vw)] flex-col border-l border-line bg-panel shadow-lg outline-none">
            <RunWorkflowForm
              def={props.def}
              submitting={submitting}
              setSubmitting={setSubmitting}
            />
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  )
}

function RunWorkflowForm(props: {
  def: WorkflowDefSummary
  submitting: boolean
  setSubmitting: (v: boolean) => void
}): JSX.Element {
  const { def, submitting, setSubmitting } = props
  const navigate = useNavigate()
  const [values, setValues] = useState<FieldFormValues>(() => emptyFormValues(def.input))
  const [issues, setIssues] = useState<FieldIssues>({})
  const [runName, setRunName] = useState('')
  const [formError, setFormError] = useState<string | undefined>()

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
    const parsed = parseFormValues(def.input, values)
    if (!parsed.ok) {
      setIssues(parsed.issues)
      return
    }
    setSubmitting(true)
    try {
      const result = await useConnection.getState().gateway.startWorkflowRun(def.id, {
        input: parsed.value,
        label: runName.trim() || undefined,
      })
      setSubmitting(false)
      void navigate({ to: '/workflows/runs/$runId', params: { runId: result.run.id } })
    } catch (err) {
      if (isContractError(err)) {
        setIssues(issuesFromGatewayError(err))
        setFormError(err instanceof Error ? err.message : 'validation failed')
      } else {
        setFormError(err instanceof Error ? err.message : String(err))
      }
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit()
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-b border-line px-5 py-4">
        <Dialog.Title className="font-mono text-sm font-semibold text-em">
          Run {def.name}
        </Dialog.Title>
        <Dialog.Description className="mt-1 font-mono text-[11px] text-ink-dim">
          {def.id} · v{def.version}
        </Dialog.Description>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <RunNameField
          value={runName}
          onChange={setRunName}
          placeholder={previewRunLabel(def.runLabel, values)}
          disabled={submitting}
        />
        <WorkflowContractForm
          fields={def.input}
          values={values}
          issues={issues}
          disabled={submitting}
          onChange={onChange}
          idPrefix="trigger"
        />
        {formError && <p className="font-mono text-sm text-red">{formError}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Dialog.Close asChild>
          <button
            type="button"
            disabled={submitting}
            className="rounded border border-line px-4 py-2 text-sm text-ink-dim hover:border-em hover:text-ink"
          >
            Cancel
          </button>
        </Dialog.Close>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em disabled:opacity-40"
        >
          {submitting ? 'Starting…' : 'Start run'}
        </button>
      </div>
    </form>
  )
}
