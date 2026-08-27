/**
 * Agents section — collapsible named agent presets roster for the sidebar.
 * Each agent carries model, effort, system prompt, color, and target node.
 * Click to open a session with that configuration. A later click offers
 * keep-vs-reset when this agent already has a conversation.
 */

import { useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { AgentPreset, ThinkingLevel } from '@rivetos/types'
import { RivetGateway } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { useNodeName } from '../lib/node-name.js'
import { useConfirmDialog } from './confirm-dialog.js'
import { ModelPicker } from './pickers/model-picker.js'
import { EffortPicker } from './pickers/effort-picker.js'
import { modelOptions } from '../lib/model-options.js'
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
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded border border-line bg-panel px-2 py-1.5 text-xs text-ink outline-none focus:border-em disabled:opacity-50"
      >
        {uniqueNodes.map((n) => (
          <option key={n.baseUrl} value={n.baseUrl}>
            {n.name}
          </option>
        ))}
      </select>
    </div>
  )
}

interface AgentEditorProps {
  agent?: AgentPreset
  onSave: (agent: Partial<AgentPreset>) => void
  onCancel: () => void
  disabled?: boolean
}

function AgentEditor({ agent, onSave, onCancel, disabled }: AgentEditorProps): JSX.Element {
  const { baseUrl } = useConnection()
  const [name, setName] = useState(agent?.name ?? '')
  const [color, setColor] = useState(agent?.color ?? '')
  const [model, setModel] = useState(agent?.model ?? '')
  const [effort, setEffort] = useState<ThinkingLevel>(agent?.effort ?? 'medium')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '')
  const [nodeBaseUrl, setNodeBaseUrl] = useState(agent?.nodeBaseUrl ?? baseUrl)
  const nodeLocked = Boolean(agent)

  const catalog = useQuery({
    queryKey: ['catalog-agents', nodeBaseUrl],
    queryFn: ({ signal }) =>
      new RivetGateway({ baseUrl: nodeBaseUrl, authMode: 'mtls' }).catalogAgents(signal),
    staleTime: 300_000,
  })
  const models = modelOptions(catalog.data?.agents ?? [])

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const patch: Partial<AgentPreset> = { name, color, model, effort, systemPrompt }
    if (!nodeLocked) patch.nodeBaseUrl = nodeBaseUrl
    onSave(patch)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded border border-line bg-panel p-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-em">{agent ? 'Edit Agent' : 'New Agent'}</span>
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
        <ModelPicker
          value={model}
          options={models}
          onChange={setModel}
          disabled={disabled || catalog.isError}
          unavailable={catalog.isError}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-ink-dim">Effort</label>
        <EffortPicker value={effort} onChange={setEffort} />
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
  const { data: health, isPending } = useQuery({
    queryKey: ['agent-node-health', agent.nodeBaseUrl],
    queryFn: async ({ signal }) => {
      const ok = await new RivetGateway({
        baseUrl: agent.nodeBaseUrl,
        authMode: 'mtls',
      }).health(signal)
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

export function AgentsSection(): JSX.Element {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { baseUrl, roster, switchTo } = useConnection()
  const { addDraft, setActive } = useChat()
  const chatSettings = useChatSettings()
  const [collapsed, setCollapsed] = useState(false)
  const [editing, setEditing] = useState<RosterAgent | null>(null)
  const [creating, setCreating] = useState(false)
  const dialog = useConfirmDialog()

  const uniqueNodes: NodeChoice[] = uniqueRosterNodes(roster, baseUrl)

  const nodeQueries = useQuery({
    queryKey: ['agents-all-nodes', uniqueNodes.map((n) => n.baseUrl)],
    queryFn: async ({ signal }) => {
      const results = await Promise.all(
        uniqueNodes.map(async (node) => {
          try {
            const res = await new RivetGateway({
              baseUrl: node.baseUrl,
              authMode: 'mtls',
            }).agentsList(signal)
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
    mutationFn: (agent: Partial<AgentPreset>) =>
      new RivetGateway({ baseUrl: agent.nodeBaseUrl!, authMode: 'mtls' }).agentCreate({
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
    mutationFn: ({
      id,
      agent,
      targetNode,
    }: {
      id: string
      agent: Partial<AgentPreset>
      targetNode: string
    }) =>
      new RivetGateway({ baseUrl: targetNode, authMode: 'mtls' }).agentUpdate(id, {
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
    mutationFn: ({ id, targetNode }: { id: string; targetNode: string }) =>
      new RivetGateway({ baseUrl: targetNode, authMode: 'mtls' }).agentDelete(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['agents-all-nodes'] }),
  })

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
      const listed = await new RivetGateway({
        baseUrl: nodeBaseUrl,
        authMode: 'mtls',
      }).harnessSessions()
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
            onClick={() => setCreating(true)}
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
          {!isLoading && agents.length === 0 && !creating && !editing && (
            <div className="px-2 text-xs text-ink-dim">no agents yet</div>
          )}
          {agents.map((agent) =>
            editing?.id === agent.id ? (
              <AgentEditor
                key={agent.id}
                agent={agent}
                onSave={(updated) =>
                  updateMutation.mutate({
                    id: agent.id,
                    agent: updated,
                    targetNode: agent.sourceNodeBaseUrl,
                  })
                }
                onCancel={() => setEditing(null)}
                disabled={updateMutation.isPending}
              />
            ) : (
              <AgentRow
                key={agent.id}
                agent={agent}
                onOpen={() => handleOpen(agent)}
                onEdit={() => setEditing(agent)}
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
            ),
          )}
          {creating && (
            <AgentEditor
              onSave={(agent) => createMutation.mutate(agent)}
              onCancel={() => setCreating(false)}
              disabled={createMutation.isPending}
            />
          )}
        </div>
      )}
    </div>
  )
}
