/**
 * "New workflow" — create a blank def or duplicate an existing one, then hand
 * the new id back so the caller can open it on the flows canvas.
 */

import { useState, type JSX } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import type { WorkflowDefSummary } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { slugifyWorkflowId } from '../lib/workflow-runs/index.js'
import { SegmentedControl } from './segmented-control.js'
import { Select } from './select.js'

type CreateMode = 'scratch' | 'duplicate'

export interface NewWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workflows: WorkflowDefSummary[]
  /** Files-root-relative defs roots from GET /api/workflows. */
  createRoots: string[]
  /** Open in duplicate mode with this source preselected. */
  duplicateFrom?: string
  onCreated: (workflowId: string) => void
}

const inputCls =
  'w-full rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim focus:border-em'
const labelCls = 'mb-1 block font-mono text-xs text-ink'

export function NewWorkflowDialog(props: NewWorkflowDialogProps): JSX.Element {
  const [submitting, setSubmitting] = useState(false)
  return (
    <Dialog.Root open={props.open} onOpenChange={(o) => !submitting && props.onOpenChange(o)}>
      {/* Content unmounts on close, so every open starts from a fresh form;
          list refetches while open don't reset it. */}
      {props.open && (
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70" />
          <NewWorkflowForm {...props} submitting={submitting} setSubmitting={setSubmitting} />
        </Dialog.Portal>
      )}
    </Dialog.Root>
  )
}

function NewWorkflowForm(
  props: NewWorkflowDialogProps & {
    submitting: boolean
    setSubmitting: (v: boolean) => void
  },
): JSX.Element {
  const { onOpenChange, workflows, createRoots, duplicateFrom, onCreated } = props
  const { submitting, setSubmitting } = props
  const queryClient = useQueryClient()
  const source = workflows.find((w) => w.id === duplicateFrom)
  // A card's "Duplicate" opens straight into duplicate mode, prefilled.
  const [mode, setMode] = useState<CreateMode>(source ? 'duplicate' : 'scratch')
  const [name, setName] = useState(source ? `${source.name} copy` : '')
  const [id, setId] = useState(source ? slugifyWorkflowId(`${source.id}-copy`) : '')
  /** Once the id is hand-edited (or prefilled), stop deriving it from the name. */
  const [idTouched, setIdTouched] = useState(Boolean(source))
  const [description, setDescription] = useState('')
  const [from, setFrom] = useState(duplicateFrom ?? workflows.at(0)?.id ?? '')
  const [root, setRoot] = useState(createRoots[0] ?? '')
  const [error, setError] = useState<string | undefined>()

  const effectiveId = idTouched ? id : slugifyWorkflowId(name)

  const submit = async (): Promise<void> => {
    setError(undefined)
    if (!name.trim()) return setError('Name is required')
    if (!effectiveId) return setError('Id is required')
    if (mode === 'duplicate' && !from) return setError('Pick a workflow to duplicate')
    setSubmitting(true)
    try {
      const res = await useConnection.getState().gateway.createWorkflow({
        id: effectiveId,
        name: name.trim(),
        description: description.trim() || undefined,
        root: root || undefined,
        from: mode === 'duplicate' ? from : undefined,
      })
      await queryClient.invalidateQueries({ queryKey: ['workflows'] })
      onOpenChange(false)
      onCreated(res.workflow.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-line bg-panel p-5 shadow-lg outline-none">
      <Dialog.Title className="mb-1 font-mono text-sm font-semibold text-em">
        New workflow
      </Dialog.Title>
      <Dialog.Description className="mb-4 text-xs text-ink-dim">
        Opens on the flows canvas — wire up steps there and Save.
      </Dialog.Description>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="flex flex-col gap-4"
      >
        <SegmentedControl
          ariaLabel="Create from"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'scratch', label: 'From scratch' },
            {
              value: 'duplicate',
              label: 'Duplicate',
              disabled: workflows.length === 0,
              title: workflows.length === 0 ? 'No workflows to duplicate' : undefined,
            },
          ]}
        />

        {mode === 'duplicate' && (
          <div>
            <span className={labelCls}>Copy of</span>
            <Select
              aria-label="Workflow to duplicate"
              value={from}
              options={workflows.map((w) => ({ value: w.id, label: w.name }))}
              onChange={setFrom}
              className="w-full"
            />
          </div>
        )}

        <label>
          <span className={labelCls}>Name</span>
          <input
            autoFocus
            type="text"
            value={name}
            maxLength={120}
            disabled={submitting}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. PR review"
            className={inputCls}
          />
        </label>

        <label>
          <span className={labelCls}>
            Id <span className="text-ink-dim">— directory name and API id</span>
          </span>
          <input
            type="text"
            value={effectiveId}
            maxLength={64}
            disabled={submitting}
            spellCheck={false}
            onChange={(e) => {
              setIdTouched(true)
              setId(e.target.value)
            }}
            placeholder="pr-review"
            className={`${inputCls} font-mono`}
          />
        </label>

        <label>
          <span className={labelCls}>
            Description <span className="text-ink-dim">(optional)</span>
          </span>
          <textarea
            value={description}
            rows={2}
            disabled={submitting}
            onChange={(e) => setDescription(e.target.value)}
            className={inputCls}
          />
        </label>

        {createRoots.length > 1 && (
          <div>
            <span className={labelCls}>Location</span>
            <Select
              aria-label="Workflows root"
              value={root}
              options={createRoots.map((r) => ({ value: r, label: r || '(files root)' }))}
              onChange={setRoot}
              className="w-full"
            />
          </div>
        )}

        {error && <p className="font-mono text-xs text-red">{error}</p>}

        <div className="flex justify-end gap-2">
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
            {submitting ? 'Creating…' : mode === 'duplicate' ? 'Duplicate' : 'Create'}
          </button>
        </div>
      </form>
    </Dialog.Content>
  )
}
