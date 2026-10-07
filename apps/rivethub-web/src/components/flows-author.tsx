/**
 * Load / save a flows graph for a workflow def under the files root.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { parse as parseYaml } from 'yaml'
import { GatewayError, type RivetGateway } from '@rivetos/gateway-client'
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
import {
  applyAgentFile,
  applyRunTsBindings,
  authorGraphFromOutline,
  stepBindingsFromRunTs,
} from '../lib/workflow-runs/flow-hydrate.js'
import {
  emptyFlowGraph,
  FLOW_START_ID,
  type FlowAuthorGraph,
} from '../lib/workflow-runs/flow-graph.js'
import {
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from '../lib/workflow-runs/flow-history.js'
import { autoLayoutAuthorGraph } from '../lib/workflow-runs/flow-layout.js'
import { flowIssues } from '../lib/workflow-runs/flow-compile.js'
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
  const [history, setHistory] = useState(() => createHistory<FlowAuthorGraph>(emptyFlowGraph()))
  const graph = history.present
  /** Graph as last loaded or saved — unsaved means "differs from this". */
  const [savedGraph, setSavedGraph] = useState<FlowAuthorGraph>(graph)
  /** Bumped per load and per Tidy so the canvas re-fits the graph. */
  const [fitSeq, setFitSeq] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // Identity, not deep equality: every edit makes a new graph, and undo back
  // to the saved one returns that exact object — so undoing all edits is clean.
  const dirty = graph !== savedGraph
  const [saveMsg, setSaveMsg] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const hadFlowsJson = useRef(false)
  /** Hand-written run.ts (no flows.json, real outline): the canvas is a projection of it. */
  const [codeOwned, setCodeOwned] = useState(false)
  const outlineRef = useRef(props.outline)
  outlineRef.current = props.outline

  useEffect(() => {
    props.onDirtyChange?.(dirty)
  }, [dirty, props.onDirtyChange])

  // An editor that goes away takes its unsaved state with it: the page's
  // guard must not keep asking about edits nobody can see or save.
  const reportDirty = useRef(props.onDirtyChange)
  reportDirty.current = props.onDirtyChange
  useEffect(
    () => () => {
      reportDirty.current?.(false)
    },
    [],
  )

  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  /** Fresh history at a loaded graph: nothing to undo, nothing unsaved. */
  const resetTo = (g: FlowAuthorGraph): void => {
    setHistory(createHistory(g))
    setSavedGraph(g)
    setFitSeq((n) => n + 1)
  }

  // Key only on the def identity. `props.outline` is an unstable array from
  // query data — depending on it re-hydrated from disk on every refetch and
  // wiped unsaved edits. While dirty, a later run of this effect (def switch
  // is the only trigger) still resets; we never clear dirty on a no-op re-hydrate.
  useEffect(() => {
    const cancelRef = { cancelled: false }
    setLoaded(false)
    setSaveMsg(undefined)
    setSelectedId(null)
    const gw = useConnection.getState().gateway
    const path = props.editPath ? joinRel(props.editPath, FLOWS_FILE) : ''
    void (async () => {
      if (path) {
        try {
          const text = await gw.filesReadText(path)
          if (!cancelRef.cancelled) {
            hadFlowsJson.current = true
            setCodeOwned(false)
            resetTo(parseFlowsFile(text))
            setLoaded(true)
            return
          }
        } catch (err) {
          if (!(err instanceof GatewayError && err.status === 404)) {
            if (!cancelRef.cancelled) setSaveMsg(err instanceof Error ? err.message : String(err))
          }
        }
      }
      if (cancelRef.cancelled) return
      hadFlowsJson.current = false
      setCodeOwned((outlineRef.current?.length ?? 0) > 1)
      let hydrated = authorGraphFromOutline(outlineRef.current)
      if (props.editPath) hydrated = await hydrateFromDefFiles(gw, props.editPath, hydrated)
      // The cleanup can set `cancelled` during the await above.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!cancelRef.cancelled) {
        resetTo(hydrated)
        setLoaded(true)
      }
    })()
    return () => {
      cancelRef.cancelled = true
    }
  }, [props.editPath, props.workflowId])

  const onChange = useCallback((next: FlowAuthorGraph, coalesceKey?: string) => {
    setHistory((h) => pushHistory(h, next, coalesceKey))
    setSaveMsg(undefined)
  }, [])
  const undo = useCallback(() => setHistory(undoHistory), [])
  const redo = useCallback(() => setHistory(redoHistory), [])
  const tidy = useCallback(() => {
    setHistory((h) => pushHistory(h, autoLayoutAuthorGraph(h.present, FLOW_START_ID)))
    setFitSeq((n) => n + 1)
  }, [])

  const knownIds = props.workflowOptions.map((o) => o.value).join('\n')
  const issues = useMemo(
    () => flowIssues(graph, { knownWorkflowIds: knownIds ? knownIds.split('\n') : [] }),
    [graph, knownIds],
  )
  const blocking = issues.some((i) => i.severity === 'error')

  const onSave = async (): Promise<void> => {
    if (!props.editPath) return
    const savingGraph = graph
    if (!hadFlowsJson.current && (props.outline?.length ?? 0) > 1) {
      const ok = await confirmDialog.confirm(
        'This definition has no flows.json yet, so its run.ts was written by hand. Saving replaces run.ts with code generated from the canvas: the outline is linearized, and step prompts, declared outputs, and any other logic in the old script are discarded. Existing agent files and scripts are kept. Continue?',
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
      const { files, createOnly, owned } = compileFlow(savingGraph, {
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
      setCodeOwned(false)
      setSavedGraph(savingGraph)
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
  const canEdit = editable && loaded

  // ⌘S saves; ⌘Z / ⇧⌘Z / ⌘Y undo and redo — except inside text fields, which
  // keep their own native undo (field edits are still one step on the canvas).
  const keys = useRef({ save: onSave, undo, redo, canEdit, saving })
  keys.current = { save: onSave, undo, redo, canEdit, saving }
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const k = keys.current
      if (!k.canEdit) return
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        if (!k.saving) void k.save()
        return
      }
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        k.undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        k.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {confirmDialog.element}
      {codeOwned && editable && (
        <p className="shrink-0 border-b border-line bg-panel px-3 py-2 font-mono text-[11px] text-ink-dim">
          This workflow’s <span className="text-ink">run.ts</span> was written by hand — the canvas
          shows its outline. Saving here replaces run.ts with code generated from the canvas.
        </p>
      )}
      <div className="min-h-0 flex-1">
        <FlowsWorkbench
          graph={graph}
          onChange={editable ? onChange : undefined}
          editable={canEdit}
          issues={editable ? issues : undefined}
          fitKey={`${props.workflowId}:${String(fitSeq)}`}
          workflowOptions={props.workflowOptions}
          workflowId={props.workflowId}
          onWorkflowChange={props.onWorkflowChange}
          selectedId={selectedId}
          onSelect={setSelectedId}
          toolbarLeft={props.toolbarLeft}
          toolbarRight={
            <>
              {editable && (
                <div className="flex items-center gap-0.5 rounded border border-line p-0.5 font-mono text-xs text-ink-dim">
                  <button
                    type="button"
                    disabled={!canEdit || history.past.length === 0}
                    onClick={undo}
                    title="Undo (⌘Z)"
                    className="rounded px-2 py-0.5 hover:bg-panel-2 hover:text-ink disabled:opacity-40"
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    disabled={!canEdit || history.future.length === 0}
                    onClick={redo}
                    title="Redo (⇧⌘Z)"
                    className="rounded px-2 py-0.5 hover:bg-panel-2 hover:text-ink disabled:opacity-40"
                  >
                    Redo
                  </button>
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={tidy}
                    title="Lay nodes out left to right by step order"
                    className="rounded px-2 py-0.5 hover:bg-panel-2 hover:text-ink disabled:opacity-40"
                  >
                    Tidy
                  </button>
                </div>
              )}
              {editable && (
                <button
                  type="button"
                  title={blocking ? 'Fix the problems marked ✕ to save' : 'Save (⌘S)'}
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
      </div>
    </div>
  )
}

async function ensureDir(gw: RivetGateway, parent: string, name: string): Promise<void> {
  try {
    await gw.filesMkdir(parent, name)
  } catch (err) {
    if (err instanceof GatewayError && err.status === 409) return
    throw err
  }
}

/**
 * A def without flows.json was written by hand: read run.ts and the agent
 * files it names so the canvas shows the agents and scripts the workflow
 * really uses. Missing or unreadable files leave the outline guess in place.
 */
async function hydrateFromDefFiles(
  gw: RivetGateway,
  editPath: string,
  graph: FlowAuthorGraph,
): Promise<FlowAuthorGraph> {
  let next = graph
  try {
    const runTs = await gw.filesReadText(joinRel(editPath, 'run.ts'))
    next = applyRunTsBindings(next, stepBindingsFromRunTs(runTs))
  } catch {
    // No readable run.ts — keep the outline guess.
  }
  const nodes = await Promise.all(
    next.nodes.map(async (n) => {
      if (n.kind !== 'agent' || !n.agentName) return n
      try {
        const text = await gw.filesReadText(joinRel(editPath, `agents/${n.agentName}.md`))
        return applyAgentFile(n, text)
      } catch {
        return n
      }
    }),
  )
  return { ...next, nodes }
}
