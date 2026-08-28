/**
 * Agents section — collapsible named agent presets roster for the sidebar.
 * Each agent carries model, effort, system prompt, color, and target node.
 * Click to open a session with that configuration. A later click offers
 * keep-vs-reset when this agent already has a conversation.
 *
 * All node calls go through gatewayFor (desktop mTLS pipe, #491) — a raw
 * RivetGateway on an https base cannot authenticate from the desktop shell.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { AgentPreset, ThinkingLevel } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { useNodeName } from '../lib/node-name.js'
import { useConfirmDialog } from './confirm-dialog.js'
import { Select } from './select.js'
import { modelOptions } from '../lib/model-options.js'
import { gatewayFor } from '../lib/agent-gateway.js'
import { uuidv4 } from '../lib/uuid.js'
import {
  clearAgentLastSession,
  getAgentLastSession,
  setAgentLastSession,
} from '../lib/agent-session.js'
import {
  agentOpenPlan,
  KEEP_DIALOG_NOTE,
  nodeHealthStatus,
  sessionPointerMatches,
  uniqueRosterNodes,
  type NodeChoice,
} from '../lib/agent-roster.js'
import { nativeIdOf } from '../lib/harness-chat.js'
import { useChat } from '../stores/chat.js'
import { useChatSettings } from '../stores/chat-settings.js'

type RosterAgent = AgentPreset & { sourceNodeBaseUrl: string }

const lastGoodAgentsByNode = new Map<string, AgentPreset[]>()

const EFFORT_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
]

interface NodeSelectorProps {
  value: string
  onChange: (baseUrl: string) => void
  disabled?: boolean
}

function NodeSelector({ value, onChange, disabled }: NodeSelectorProps): JSX.Element {
  const { roster, baseUrl: currentBaseUrl } = useConnection()
  const rosterNodes = uniqueRosterNodes(roster, currentBaseUrl)
  const uniqueNodes =
    value && !rosterNodes.some((n) => n.baseUrl === value)
      ? [...rosterNodes, { name: value, baseUrl: value }]
      : rosterNodes

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-ink-dim">Node</label>
      <Select
        value={value}
        options={uniqueNodes.map((n) => ({ value: n.baseUrl, label: n.name }))}
        onChange={onChange}
        disabled={disabled}
        label="Node"
        className="w-full"
      />
    </div>
  )
}

interface AgentEditorProps {
  agent?: AgentPreset
  onSave: (agent: Partial<AgentPreset>) => void
  onCancel: () => void
  disabled?: boolean
  errorText?: string
}

function AgentEditor({
  agent,
  onSave,
  onCancel,
  disabled,
  errorText,
}: AgentEditorProps): JSX.Element {
  const { baseUrl, transportEpoch } = useConnection()
  const [name, setName] = useState(agent?.name ?? '')
  const [color, setColor] = useState(agent?.color ?? '')
  const [model, setModel] = useState(agent?.model ?? '')
  const [effort, setEffort] = useState<ThinkingLevel>(agent?.effort ?? 'medium')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '')
  const [nodeBaseUrl, setNodeBaseUrl] = useState(agent?.nodeBaseUrl ?? baseUrl)
  const nodeLocked = Boolean(agent)
  const formRef = useRef<HTMLFormElement | null>(null)
  // A picker's Radix popper still being mounted means that popover owns the
  // event (its own dismiss handlers run first, in the same dispatch).
  const pickerOpen = (): boolean =>
    document.querySelector('[data-radix-popper-content-wrapper]') !== null
  // Only a press that STARTED on the backdrop (with no picker open) may
  // cancel — dismissing a picker by clicking outside must not also land on
  // the backdrop and unmount the editor, losing the draft.
  const backdropArmed = useRef(false)

  const catalog = useQuery({
    queryKey: ['catalog-agents', nodeBaseUrl, transportEpoch],
    queryFn: async ({ signal }) => (await gatewayFor(nodeBaseUrl)).catalogAgents(signal),
    staleTime: 300_000,
  })
  const models = modelOptions(catalog.data?.agents ?? [])

  // Restore focus to the opener (Plus / Pencil) when the dialog closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => opener?.focus()
  }, [])

  // Document-level keys, mirroring confirm-dialog: Escape cancels and Tab
  // cycles within the dialog — except while a picker popover is open, which
  // owns both.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (pickerOpen()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      e.preventDefault()
      const el = formRef.current
      const focusables = el
        ? Array.from(el.querySelectorAll<HTMLElement>('input, button, textarea')).filter(
            (n) => !n.hasAttribute('disabled'),
          )
        : []
      if (focusables.length === 0) return
      const idx = focusables.indexOf(document.activeElement as HTMLElement)
      const next =
        idx === -1
          ? focusables[e.shiftKey ? focusables.length - 1 : 0]
          : focusables[(idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length]
      next.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const patch: Partial<AgentPreset> = { name, color, model, effort, systemPrompt }
    if (!nodeLocked) patch.nodeBaseUrl = nodeBaseUrl
    onSave(patch)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70"
      role="presentation"
      onPointerDown={(e) => {
        backdropArmed.current = e.target === e.currentTarget && !pickerOpen()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && backdropArmed.current) onCancel()
        backdropArmed.current = false
      }}
    >
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-label={agent ? 'Edit agent' : 'New agent'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="flex max-h-[85vh] w-96 flex-col gap-3 overflow-y-auto rounded-md border border-line bg-panel p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-em">
            {agent ? 'Edit Agent' : 'New Agent'}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="text-ink-dim hover:text-em"
            aria-label="cancel"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-dim">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Agent name"
            required
            autoFocus
            disabled={disabled}
            className="rounded border border-line bg-panel-2 px-2 py-1.5 text-xs text-ink outline-none focus:border-em disabled:opacity-50"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-dim">Color (optional)</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color || '#3b82f6'}
              onChange={(e) => setColor(e.target.value)}
              disabled={disabled}
              className="size-8 rounded border border-line disabled:opacity-50"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="#3b82f6"
              disabled={disabled}
              className="flex-1 rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-em disabled:opacity-50"
            />
          </div>
        </div>

        <NodeSelector
          value={nodeBaseUrl}
          onChange={setNodeBaseUrl}
          disabled={disabled || nodeLocked}
        />

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-dim">Model</label>
          <Select
            value={model}
            options={models}
            onChange={setModel}
            disabled={disabled || catalog.isError}
            title={catalog.isError ? 'catalog unavailable' : undefined}
            label="Model"
            className="w-full"
          />
          {catalog.isError && (
            <span className="text-[10px] text-red">catalog unavailable on this node</span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-dim">Effort</label>
          <Select
            value={effort}
            options={EFFORT_OPTIONS}
            onChange={(v) => setEffort(v as ThinkingLevel)}
            disabled={disabled}
            label="Effort"
            className="w-full"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-dim">System Prompt (optional)</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Custom system prompt..."
            rows={4}
            disabled={disabled}
            className="resize-y rounded border border-line bg-panel-2 px-2 py-1.5 text-xs text-ink outline-none focus:border-em disabled:opacity-50"
          />
        </div>

        {errorText && <div className="text-xs text-red">{errorText}</div>}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={
              !name.trim() ||
              disabled ||
              (color.trim() !== '' && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color.trim()))
            }
            className="flex-1 rounded bg-em px-3 py-1.5 text-xs font-semibold text-bg hover:opacity-90 disabled:opacity-50"
          >
            {agent ? 'Update' : 'Create'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={disabled}
            className="rounded border border-line px-3 py-1.5 text-xs text-ink-dim hover:border-em hover:text-em disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

interface AgentRowProps {
  agent: RosterAgent
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}

function AgentRow({ agent, onOpen, onEdit, onDelete }: AgentRowProps): JSX.Element {
  const nodeName = useNodeName(agent.nodeBaseUrl)
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const { data: health, isPending } = useQuery({
    queryKey: ['agent-node-health', agent.nodeBaseUrl, transportEpoch],
    queryFn: async ({ signal }) => {
      const ok = await (await gatewayFor(agent.nodeBaseUrl)).health(signal)
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return ok
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 0,
  })
  const status = nodeHealthStatus(health, isPending)
  const nodeOffline = status === 'offline'

  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-panel-2">
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={`${agent.name} on ${nodeName ?? agent.nodeBaseUrl}`}
        disabled={nodeOffline}
      >
        {agent.color && (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: agent.color }}
            aria-hidden
          />
        )}
        <span className="min-w-0 truncate text-xs text-ink">{agent.name}</span>
        {nodeOffline && (
          <span className="shrink-0 text-[10px] text-red" title="Node offline">
            ●
          </span>
        )}
      </button>
      <div className="hidden shrink-0 gap-1 group-hover:flex">
        <button
          onClick={onEdit}
          className="text-ink-dim hover:text-em"
          aria-label="edit"
          title="edit"
        >
          <Pencil className="size-3" />
        </button>
        <button
          onClick={onDelete}
          className="text-ink-dim hover:text-red"
          aria-label="delete"
          title="delete"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  )
}

const mutationError = (err: unknown): string =>
  err instanceof Error ? err.message : 'request failed'

export function AgentsSection(): JSX.Element {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { baseUrl, roster, switchTo, transportEpoch } = useConnection()
  const { addDraft, setActive } = useChat()
  const chatSettings = useChatSettings()
  const [collapsed, setCollapsed] = useState(false)
  const [editing, setEditing] = useState<RosterAgent | null>(null)
  const [creating, setCreating] = useState(false)
  const dialog = useConfirmDialog()

  const uniqueNodes: NodeChoice[] = uniqueRosterNodes(roster, baseUrl)

  const nodeQueries = useQuery({
    queryKey: ['agents-all-nodes', uniqueNodes.map((n) => n.baseUrl), transportEpoch],
    queryFn: async ({ signal }) => {
      const results = await Promise.all(
        uniqueNodes.map(async (node) => {
          try {
            const res = await (await gatewayFor(node.baseUrl)).agentsList(signal)
            lastGoodAgentsByNode.set(node.baseUrl, res.agents)
            return { nodeBaseUrl: node.baseUrl, agents: res.agents }
          } catch (err) {
            if (signal.aborted) throw err
            const kept = lastGoodAgentsByNode.get(node.baseUrl) ?? []
            return { nodeBaseUrl: node.baseUrl, agents: kept }
          }
        }),
      )
      const allAgents: RosterAgent[] = []
      const seen = new Set<string>()
      for (const result of results) {
        for (const agent of result.agents) {
          if (seen.has(agent.id)) continue
          seen.add(agent.id)
          allAgents.push({ ...agent, sourceNodeBaseUrl: result.nodeBaseUrl })
        }
      }
      return allAgents
    },
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  })

  const agents = nodeQueries.data ?? []
  const isLoading = nodeQueries.isLoading

  const createMutation = useMutation({
    mutationFn: async (agent: Partial<AgentPreset>) =>
      (await gatewayFor(agent.nodeBaseUrl!)).agentCreate({
        name: agent.name!,
        color: agent.color,
        model: agent.model,
        effort: agent.effort,
        systemPrompt: agent.systemPrompt,
        nodeBaseUrl: agent.nodeBaseUrl!,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents-all-nodes'] })
      setCreating(false)
    },
  })

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      agent,
      targetNode,
    }: {
      id: string
      agent: Partial<AgentPreset>
      targetNode: string
    }) =>
      (await gatewayFor(targetNode)).agentUpdate(id, {
        name: agent.name,
        color: agent.color,
        model: agent.model,
        effort: agent.effort,
        systemPrompt: agent.systemPrompt,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents-all-nodes'] })
      setEditing(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async ({ id, targetNode }: { id: string; targetNode: string }) =>
      (await gatewayFor(targetNode)).agentDelete(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['agents-all-nodes'] }),
  })

  // Stable cancel handlers — the editor's document keydown effect depends on
  // onCancel, so an inline lambda would resubscribe it every parent render.
  const { reset: resetCreate } = createMutation
  const { reset: resetUpdate } = updateMutation
  const cancelCreate = useCallback(() => {
    setCreating(false)
    resetCreate()
  }, [resetCreate])
  const cancelEdit = useCallback(() => {
    setEditing(null)
    resetUpdate()
  }, [resetUpdate])

  const applyAgentSettings = (sessionId: string, agent: AgentPreset, nodeBaseUrl: string): void => {
    chatSettings.set(`${nodeBaseUrl}::${sessionId}`, {
      agent: agent.model || '',
      effort: agent.effort,
      systemPrompt: agent.systemPrompt || '',
    })
    setAgentLastSession(agent.id, sessionId, nodeBaseUrl)
  }

  const ensureNode = (nodeBaseUrl: string): boolean => {
    if (nodeBaseUrl === baseUrl) return true
    if (!switchTo(nodeBaseUrl)) return false
    return useConnection.getState().baseUrl === nodeBaseUrl
  }

  const openFresh = (agent: AgentPreset, nodeBaseUrl: string): void => {
    const plan = agentOpenPlan('fresh')
    const sessionId = uuidv4()
    if (!ensureNode(nodeBaseUrl)) {
      void dialog.confirm(`Can't switch to that node — it is not in the roster.`, {
        confirmLabel: 'OK',
      })
      return
    }
    if (plan.applySettings) applyAgentSettings(sessionId, agent, nodeBaseUrl)
    if (plan.addDraft) addDraft(sessionId)
    setActive(sessionId)
    void navigate({ to: '/', search: { session: sessionId } })
  }

  const openKept = (sessionId: string, nodeBaseUrl: string): void => {
    if (!ensureNode(nodeBaseUrl)) {
      void dialog.confirm(`Can't switch to that node — it is not in the roster.`, {
        confirmLabel: 'OK',
      })
      return
    }
    setActive(sessionId)
    void navigate({ to: '/', search: { session: sessionId } })
  }

  const sessionStillExists = async (sessionId: string, nodeBaseUrl: string): Promise<boolean> => {
    const chat = useChat.getState()
    if (chat.drafts.includes(sessionId)) return true
    if ((chat.messages[sessionId] ?? []).length > 0) return true
    if ((chat.transcripts[sessionId]?.turns.length ?? 0) > 0) return true
    try {
      const listed = await (await gatewayFor(nodeBaseUrl)).harnessSessions()
      return listed.sessions.some((s) => sessionPointerMatches(sessionId, s.id, nativeIdOf))
    } catch {
      return false
    }
  }

  const handleOpen = (agent: RosterAgent): void => {
    const last = getAgentLastSession(agent.id)
    if (!last) {
      openFresh(agent, agent.nodeBaseUrl)
      return
    }
    void (async () => {
      const alive = await sessionStillExists(last.sessionId, last.nodeBaseUrl)
      if (!alive) {
        openFresh(agent, agent.nodeBaseUrl)
        return
      }
      const pick = await dialog.choose(
        `"${agent.name}" already has a conversation. Keep it, or start over? ${KEEP_DIALOG_NOTE}`,
      )
      if (pick === undefined) return
      if (pick === 'keep') openKept(last.sessionId, last.nodeBaseUrl)
      else openFresh(agent, agent.nodeBaseUrl)
    })()
  }

  return (
    <div className="border-t border-line px-2 py-2">
      {dialog.element}
      <div className="flex w-full items-center justify-between px-1 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left hover:bg-panel-2"
        >
          <span className="font-mono text-xs text-ink-dim">agents</span>
          {collapsed ? (
            <ChevronRight className="size-3 text-ink-dim" />
          ) : (
            <ChevronDown className="size-3 text-ink-dim" />
          )}
        </button>
        {!collapsed && (
          <button
            type="button"
            onClick={() => {
              setEditing(null)
              setCreating(true)
            }}
            className="text-ink-dim hover:text-em"
            aria-label="add agent"
            title="add agent"
          >
            <Plus className="size-3" />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="mt-1 flex flex-col gap-1">
          {isLoading && <div className="px-2 text-xs text-ink-dim">loading…</div>}
          {!isLoading && agents.length === 0 && !creating && (
            <div className="px-2 text-xs text-ink-dim">no agents yet</div>
          )}
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onOpen={() => handleOpen(agent)}
              onEdit={() => {
                setCreating(false)
                setEditing(agent)
              }}
              onDelete={() => {
                void (async () => {
                  if (
                    await dialog.confirm(`Delete agent "${agent.name}"?`, {
                      danger: true,
                    })
                  ) {
                    clearAgentLastSession(agent.id)
                    deleteMutation.mutate({
                      id: agent.id,
                      targetNode: agent.sourceNodeBaseUrl,
                    })
                  }
                })()
              }}
            />
          ))}
        </div>
      )}

      {editing && (
        <AgentEditor
          agent={editing}
          onSave={(updated) =>
            updateMutation.mutate({
              id: editing.id,
              agent: updated,
              targetNode: editing.sourceNodeBaseUrl,
            })
          }
          onCancel={cancelEdit}
          disabled={updateMutation.isPending}
          errorText={updateMutation.error ? mutationError(updateMutation.error) : undefined}
        />
      )}
      {creating && (
        <AgentEditor
          onSave={(agent) => createMutation.mutate(agent)}
          onCancel={cancelCreate}
          disabled={createMutation.isPending}
          errorText={createMutation.error ? mutationError(createMutation.error) : undefined}
        />
      )}
    </div>
  )
}
