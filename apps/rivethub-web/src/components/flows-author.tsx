/**
 * Load / save a flows graph for a workflow def under the files root.
 */

import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { parse as parseYaml } from 'yaml'
import { GatewayError } from '@rivetos/gateway-client'
import type { WorkflowField, WorkflowOutlineStep } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { joinRel } from '../lib/files-ui.js'
import {
  compileFlow,
  FLOWS_FILE,
  ownedPathsFromFlowsFile,
  parseFlowsFile,
  pathsToPrune,
  RUN_TS_MARKER,
} from '../lib/workflow-runs/flow-compile.js'
import { authorGraphFromOutline } from '../lib/workflow-runs/flow-hydrate.js'
import { emptyFlowGraph, type FlowAuthorGraph } from '../lib/workflow-runs/flow-graph.js'
import { FlowsWorkbench } from './flows-workbench.js'
import { useConfirmDialog } from './confirm-dialog.js'

export function FlowsAuthor(props: {
  workflowId: string
  editPath?: string
  name: string
  version: string
  description?: string
  outline?: WorkflowOutlineStep[]
  input: WorkflowField[]
  output?: WorkflowField[]
  workflowOptions: { value: string; label: string }[]
  onWorkflowChange?: (id: string) => void
  toolbarLeft?: ReactNode
  toolbarRight?: ReactNode
  inspectorExtra?: ReactNode
  onDirtyChange?: (dirty: boolean) => void
}): JSX.Element {
  const editable = Boolean(props.editPath)
  const queryClient = useQueryClient()
  const confirmDialog = useConfirmDialog()
  const [graph, setGraph] = useState<FlowAuthorGraph>(emptyFlowGraph)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const hadFlowsJson = useRef(false)
  const outlineRef = useRef(props.outline)
  outlineRef.current = props.outline

  useEffect(() => {
    props.onDirtyChange?.(dirty)
  }, [dirty, props.onDirtyChange])

  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  // Key only on the def identity. `props.outline` is an unstable array from
  // query data — depending on it re-hydrated from disk on every refetch and
  // wiped unsaved edits. While dirty, a later run of this effect (def switch
  // is the only trigger) still resets; we never clear dirty on a no-op re-hydrate.
  useEffect(() => {
    const cancelRef = { cancelled: false }
    setLoaded(false)
    setSaveMsg(undefined)
    setSelectedId(null)
    setDirty(false)
    const gw = useConnection.getState().gateway
    const path = props.editPath ? joinRel(props.editPath, FLOWS_FILE) : ''
    void (async () => {
      if (path) {
        try {
          const text = await gw.filesReadText(path)
          if (!cancelRef.cancelled) {
            hadFlowsJson.current = true
            setGraph(parseFlowsFile(text))
            setLoaded(true)
            return
          }
        } catch (err) {
          if (!(err instanceof GatewayError && err.status === 404)) {
            if (!cancelRef.cancelled) setSaveMsg(err instanceof Error ? err.message : String(err))
          }
        }
      }
      if (!cancelRef.cancelled) {
        hadFlowsJson.current = false
        setGraph(authorGraphFromOutline(outlineRef.current))
        setLoaded(true)
      }
    })()
    return () => {
      cancelRef.cancelled = true
    }
  }, [props.editPath, props.workflowId])

  const onChange = useCallback((next: FlowAuthorGraph) => {
    setGraph(next)
    setDirty(true)
    setSaveMsg(undefined)
  }, [])

  const onSave = async (): Promise<void> => {
    if (!props.editPath) return
    if (!hadFlowsJson.current && (props.outline?.length ?? 0) > 1) {
      const ok = await confirmDialog.confirm(
        'This definition has no flows.json yet. Saving writes the canvas over run.ts and linearizes the existing outline (branches and parallel structure in the old script are replaced). Continue?',
        { confirmLabel: 'Save' },
      )
      if (!ok) return
    }
    setSaving(true)
    setSaveMsg(undefined)
    const gw = useConnection.getState().gateway
    try {
      let input = props.input
      let output = props.output ?? []
      let version = props.version
      let name = props.name
      let description = props.description
      let budgets: { maxTokens?: number; maxCost?: number; maxConcurrentRuns?: number } | undefined
      try {
        const raw = await gw.filesReadText(joinRel(props.editPath, 'workflow.yaml'))
        const doc = parseYaml(raw) as Record<string, unknown>
        if (Array.isArray(doc.input)) input = doc.input as WorkflowField[]
        if (Array.isArray(doc.output)) output = doc.output as WorkflowField[]
        if (typeof doc.version === 'string') version = doc.version
        if (typeof doc.name === 'string') name = doc.name
        if (typeof doc.description === 'string') description = doc.description
        if (doc.budgets && typeof doc.budgets === 'object' && !Array.isArray(doc.budgets)) {
          const b = doc.budgets as Record<string, unknown>
          budgets = {
            maxTokens: typeof b.maxTokens === 'number' ? b.maxTokens : undefined,
            maxCost: typeof b.maxCost === 'number' ? b.maxCost : undefined,
            maxConcurrentRuns:
              typeof b.maxConcurrentRuns === 'number' ? b.maxConcurrentRuns : undefined,
          }
        }
      } catch {
        // New def or unreadable yaml — compile with props.
      }
      const { files, createOnly, owned } = compileFlow(graph, {
        id: props.workflowId,
        name,
        version,
        description,
        input,
        output,
        budgets,
        knownWorkflowIds: props.workflowOptions.map((o) => o.value),
      })
      const skipExisting = new Set(createOnly)
      const prune = hadFlowsJson.current

      let previousOwned: string[] | undefined
      let runTsIsGenerated = true
      if (prune) {
        try {
          const prev = await gw.filesReadText(joinRel(props.editPath, FLOWS_FILE))
          previousOwned = ownedPathsFromFlowsFile(prev)
        } catch {
          previousOwned = undefined
        }
        try {
          const runTs = await gw.filesReadText(joinRel(props.editPath, 'run.ts'))
          runTsIsGenerated = runTs.includes(RUN_TS_MARKER)
        } catch {
          runTsIsGenerated = true
        }
      }

      await ensureDir(gw, props.editPath, 'agents')
      await ensureDir(gw, props.editPath, 'scripts')
      for (const [rel, body] of Object.entries(files)) {
        const full = joinRel(props.editPath, rel)
        if (skipExisting.has(rel)) {
          try {
            await gw.filesReadText(full)
            continue
          } catch (err) {
            if (!(err instanceof GatewayError && err.status === 404)) throw err
          }
        }
        if (rel.startsWith('agents/')) {
          try {
            const existing = await gw.filesReadText(full)
            if (!existing.includes(RUN_TS_MARKER)) continue
          } catch {
            // Read failed — treat as missing and write the generated file.
          }
        }
        await gw.filesSave(full, body)
      }

      const removed: string[] = []
      if (prune && runTsIsGenerated) {
        const toDelete = pathsToPrune(previousOwned, owned)
        for (const rel of toDelete) {
          try {
            const existing = await gw.filesReadText(joinRel(props.editPath, rel))
            if (!existing.includes(RUN_TS_MARKER)) continue
            await gw.filesDelete(joinRel(props.editPath, rel))
            removed.push(rel)
          } catch {
            // Best-effort — save already wrote the live files.
          }
        }
      }
      hadFlowsJson.current = true
      setDirty(false)
      setSaveMsg(removed.length > 0 ? `Saved (removed ${removed.join(', ')})` : 'Saved')
      await queryClient.invalidateQueries({ queryKey: ['workflow'] })
      await queryClient.invalidateQueries({ queryKey: ['workflows'] })
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const saveOk = Boolean(saveMsg?.startsWith('Saved'))

  return (
    <>
      {confirmDialog.element}
      <FlowsWorkbench
        graph={graph}
        onChange={editable ? onChange : undefined}
        editable={editable && loaded}
        workflowOptions={props.workflowOptions}
        workflowId={props.workflowId}
        onWorkflowChange={props.onWorkflowChange}
        selectedId={selectedId}
        onSelect={setSelectedId}
        toolbarLeft={props.toolbarLeft}
        toolbarRight={
          <>
            {editable && (
              <button
                type="button"
                disabled={saving || !loaded}
                onClick={() => void onSave()}
                className="rounded bg-em-dim px-3 py-1 font-mono text-xs font-medium text-bg hover:bg-em disabled:opacity-40"
              >
                {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            )}
            {saveMsg && (
              <span className={`font-mono text-[11px] ${saveOk ? 'text-em' : 'text-red'}`}>
                {saveMsg}
              </span>
            )}
            {props.toolbarRight}
          </>
        }
        inspectorExtra={props.inspectorExtra}
      />
    </>
  )
}

async function ensureDir(
  gw: ReturnType<typeof useConnection.getState>['gateway'],
  parent: string,
  name: string,
): Promise<void> {
  try {
    await gw.filesMkdir(parent, name)
  } catch (err) {
    if (err instanceof GatewayError && err.status === 409) return
    throw err
  }
}
