/**
 * Load / save a flows graph for a workflow def under the files root.
 */

import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { parse as parseYaml } from 'yaml'
import { GatewayError } from '@rivetos/gateway-client'
import type { WorkflowField, WorkflowOutlineStep } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { joinRel } from '../lib/files-ui.js'
import { compileFlow, FLOWS_FILE, parseFlowsFile } from '../lib/workflow-runs/flow-compile.js'
import { authorGraphFromOutline } from '../lib/workflow-runs/flow-hydrate.js'
import { emptyFlowGraph, type FlowAuthorGraph } from '../lib/workflow-runs/flow-graph.js'
import { FlowsWorkbench } from './flows-workbench.js'

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
}): JSX.Element {
  const editable = Boolean(props.editPath)
  const queryClient = useQueryClient()
  const [graph, setGraph] = useState<FlowAuthorGraph>(emptyFlowGraph)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setDirty(false)
    setSaveMsg(undefined)
    setSelectedId(null)
    const gw = useConnection.getState().gateway
    const path = props.editPath ? joinRel(props.editPath, FLOWS_FILE) : ''
    void (async () => {
      if (path) {
        try {
          const text = await gw.filesReadText(path)
          if (!cancelled) {
            setGraph(parseFlowsFile(text))
            setLoaded(true)
            return
          }
        } catch (err) {
          if (!(err instanceof GatewayError && err.status === 404)) {
            if (!cancelled) setSaveMsg(err instanceof Error ? err.message : String(err))
          }
        }
      }
      if (!cancelled) {
        setGraph(authorGraphFromOutline(props.outline))
        setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.editPath, props.workflowId, props.outline])

  const onChange = useCallback((next: FlowAuthorGraph) => {
    setGraph(next)
    setDirty(true)
    setSaveMsg(undefined)
  }, [])

  const onSave = async (): Promise<void> => {
    if (!props.editPath) return
    setSaving(true)
    setSaveMsg(undefined)
    const gw = useConnection.getState().gateway
    try {
      let input = props.input
      let output = props.output ?? []
      let version = props.version
      let name = props.name
      let description = props.description
      let budgets: { maxTokens?: number } | undefined
      try {
        const raw = await gw.filesReadText(joinRel(props.editPath, 'workflow.yaml'))
        const doc = parseYaml(raw) as Record<string, unknown>
        if (Array.isArray(doc.input)) input = doc.input as WorkflowField[]
        if (Array.isArray(doc.output)) output = doc.output as WorkflowField[]
        if (typeof doc.version === 'string') version = doc.version
        if (typeof doc.name === 'string') name = doc.name
        if (typeof doc.description === 'string') description = doc.description
        if (doc.budgets && typeof doc.budgets === 'object') {
          budgets = doc.budgets
        }
      } catch {
        // New def or unreadable yaml — compile with props.
      }
      const { files } = compileFlow(graph, {
        id: props.workflowId,
        name,
        version,
        description,
        input,
        output,
        budgets,
      })
      await ensureDir(gw, props.editPath, 'agents')
      await ensureDir(gw, props.editPath, 'scripts')
      for (const [rel, body] of Object.entries(files)) {
        await gw.filesSave(joinRel(props.editPath, rel), body)
      }
      setDirty(false)
      setSaveMsg('Saved')
      await queryClient.invalidateQueries({ queryKey: ['workflow'] })
      await queryClient.invalidateQueries({ queryKey: ['workflows'] })
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
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
            <span
              className={`font-mono text-[11px] ${saveMsg === 'Saved' ? 'text-em' : 'text-red'}`}
            >
              {saveMsg}
            </span>
          )}
          {props.toolbarRight}
        </>
      }
      inspectorExtra={props.inspectorExtra}
    />
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
    if (err instanceof GatewayError && (err.status === 409 || err.status === 400)) return
    throw err
  }
}
