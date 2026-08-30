/**
 * Agents section — collapsible named agent presets roster for the sidebar.
 * Each agent carries model, effort, system prompt, color, and a target node.
 * Click opens that agent's sticky session on agent.nodeBaseUrl without
 * switchTo; ↺ replaces the pin. Hub connection, Memory, Files stay put.
 *
 * All node calls go through gatewayFor (desktop mTLS pipe, #491) — a raw
 * RivetGateway on an https base cannot authenticate from the desktop shell.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Bot, ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import type { AgentPreset, ThinkingLevel } from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { useNodeName, urlLabel } from '../lib/node-name.js'
import { useConfirmDialog } from './confirm-dialog.js'
import { Select } from './select.js'
import { modelOptions } from '../lib/model-options.js'
import { gatewayFor } from '../lib/agent-gateway.js'
import { uuidv4 } from '../lib/uuid.js'
import {
  agentForSession,
  clearAgentLastSession,
  clearAgentSessionPointer,
  collapseAgentSlots,
  listAgentSessions,
  rekeyAgentLastSessions,
  setAgentLastSession,
  type AgentSessionPointer,
} from '../lib/agent-session.js'
import {
  aggregateAgentActivity,
  pointersToPoll,
  sessionPointerMatches,
  uniqueRosterNodes,
  type NodeChoice,
} from '../lib/agent-roster.js'
import { nativeIdOf } from '../lib/harness-chat.js'
import {
  clearSessionNodeBinding,
  rekeySessionNodeBinding,
  setSessionNodeBinding,
} from '../lib/session-node.js'
import { useChat } from '../stores/chat.js'
import { useChatSettings } from '../stores/chat-settings.js'

type RosterAgent = AgentPreset & { sourceNodeBaseUrl: string }

const lastGoodAgentsByNode = new Map<string, AgentPreset[]>()

/** Safety cap on the status fan-out. Pointers are unique per (agent, node),
 *  so the real bound is roster size — this only guards a pathological map. */
const POLL_POINTER_LIMIT = 16

/** How long row invalidations coalesce after a burst of harness events. */
const STATUS_INVALIDATE_DEBOUNCE_MS = 1_000

/** An unclaimed draft 404s on the control plane until its first turn — its
 *  pointer must survive the poll. */
function isUnclaimedDraft(sessionId: string): boolean {
  return useChat.getState().drafts.includes(sessionId)
}

/** A session the chat store still holds — a liveness (not prune) signal. */
function knownToChatStore(sessionId: string): boolean {
  const chat = useChat.getState()
  if (chat.drafts.includes(sessionId)) return true
  if ((chat.messages[sessionId] ?? []).length > 0) return true
  return (chat.transcripts[sessionId]?.turns.length ?? 0) > 0
}

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
  nodeKnown: boolean
  onOpen: () => void
  onStartOver: () => void
  onEdit: () => void
  onDelete: () => void
}

function AgentRow({
  agent,
  nodeKnown,
  onOpen,
  onStartOver,
  onEdit,
  onDelete,
}: AgentRowProps): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const transportEpoch = useConnection((s) => s.transportEpoch)
  // Session status for the nodes holding a pointer for this agent, bounded
  // to the current node + most recent others. Pointers are read inside the
  // queryFn so a fresh open is picked up on invalidation; a definitive 404
  // prunes its pointer so zombies age out of the poll instead of riding the
  // 60s interval forever.
  const { data: statuses } = useQuery({
    queryKey: ['agent-session-status', agent.id, transportEpoch],
    queryFn: async ({ signal }) => {
      const currentUrl = useConnection.getState().baseUrl
      const pointers = pointersToPoll(listAgentSessions(agent.id), currentUrl, POLL_POINTER_LIMIT)
      const rows = await Promise.all(
        pointers.map(async (p) => {
          try {
            const res = await (
              await gatewayFor(p.nodeBaseUrl)
            ).getHarnessSession(p.sessionId, signal)
            return { nodeBaseUrl: p.nodeBaseUrl, status: res.status }
          } catch (err) {
            // An aborted poll must not commit "no session" into the cache.
            if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
              throw err
            }
            // 404 is definitive for a claimed session. Compare-and-delete:
            // the prune names the 404'd id, so a stale in-flight poll can
            // never wipe a just-minted pointer on the same node.
            if (err instanceof GatewayError && err.status === 404) {
              if (isUnclaimedDraft(p.sessionId)) {
                return { nodeBaseUrl: p.nodeBaseUrl, status: undefined }
              }
              // Bare-id GET may 404 a live claimed session. List-scan
              // before prune so a reload (drafts empty) cannot steal the pin.
              try {
                const gw = await gatewayFor(p.nodeBaseUrl)
                const listed = await gw.harnessSessions(signal)
                const match = listed.sessions.find((se) =>
                  sessionPointerMatches(p.sessionId, se.id, nativeIdOf),
                )
                if (match) {
                  if (match.id !== p.sessionId) {
                    rekeyAgentLastSessions(p.sessionId, match.id)
                    rekeySessionNodeBinding(p.sessionId, match.id)
                  }
                  return { nodeBaseUrl: p.nodeBaseUrl, status: 'idle' }
                }
                clearAgentSessionPointer(agent.id, p.nodeBaseUrl, p.sessionId)
                return null
              } catch (scanErr) {
                if (
                  signal.aborted ||
                  (scanErr instanceof DOMException && scanErr.name === 'AbortError')
                ) {
                  throw scanErr
                }
                return { nodeBaseUrl: p.nodeBaseUrl, status: undefined }
              }
            }
            return { nodeBaseUrl: p.nodeBaseUrl, status: undefined }
          }
        }),
      )
      return rows.filter((r) => r !== null)
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 0,
  })
  const activity = aggregateAgentActivity(statuses ?? [], baseUrl)
  const activityNodeUrl = activity.level === 'none' ? '' : activity.nodeBaseUrl
  const activityNodeName = useNodeName(activityNodeUrl)
  // A pip on a remote node must not imply click follows it there.
  const activityLabel =
    activity.level === 'none'
      ? undefined
      : activity.nodeBaseUrl === baseUrl
        ? `${activity.level} here`
        : `${activity.level} on ${activityNodeName ?? urlLabel(activity.nodeBaseUrl)}`

  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-panel-2">
      <button
        onClick={onOpen}
        disabled={!nodeKnown}
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50"
        title={nodeKnown ? agent.name : 'node unknown'}
      >
        {agent.color && (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: agent.color }}
            aria-hidden
          />
        )}
        <span className="min-w-0 truncate text-xs text-ink">{agent.name}</span>
        {activityLabel && (
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              activity.level === 'active' ? 'animate-pulse bg-em' : 'bg-ink-dim'
            }`}
            title={activityLabel}
            aria-label={activityLabel}
          />
        )}
      </button>
      <div className="hidden shrink-0 gap-1 group-hover:flex">
        <button
          onClick={onStartOver}
          className="text-ink-dim hover:text-em"
          aria-label="start over"
          title="start a fresh conversation"
        >
          <RotateCcw className="size-3" />
        </button>
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
  const { baseUrl, roster, transportEpoch } = useConnection()
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

  // Live transitions on the current node refresh row pips between polls;
  // remote nodes are covered by the polls alone. Only sessions with a bind
  // key (session → agent) matter; invalidations are per-agent and debounced
  // so a chatty harness cannot refetch-storm the remote fan-out. The event
  // union has no dedicated delete frame — ended/error arrive as
  // session-updated transitions, and a vanished session 404-prunes on its
  // next poll. Subscribed only while the section is expanded — collapsed
  // rows render nothing to update.
  useEffect(() => {
    if (collapsed) return
    const state: {
      disposed: boolean
      sub?: { close(): void }
      pending: Set<string>
      timer?: ReturnType<typeof setTimeout>
    } = { disposed: false, pending: new Set() }
    const flushInvalidates = (): void => {
      if (state.timer) clearTimeout(state.timer)
      state.timer = undefined
      const ids = [...state.pending]
      state.pending.clear()
      for (const id of ids) {
        void queryClient.invalidateQueries({ queryKey: ['agent-session-status', id] })
      }
    }
    const scheduleInvalidate = (agentId: string): void => {
      state.pending.add(agentId)
      state.timer ??= setTimeout(flushInvalidates, STATUS_INVALIDATE_DEBOUNCE_MS)
    }
    void (async () => {
      try {
        const gw = await gatewayFor(baseUrl)
        if (state.disposed) return
        state.sub = gw.watchHarnesses((event) => {
          if (event.type !== 'session-created' && event.type !== 'session-updated') return
          // On native-id rotation the bind key may still sit under the
          // previous id — check it before giving up.
          const agentId =
            agentForSession(event.sessionId) ??
            (event.type === 'session-updated' && event.previousSessionId
              ? agentForSession(event.previousSessionId)
              : undefined)
          if (agentId) scheduleInvalidate(agentId)
        })
      } catch {
        /* node unreachable — polls still cover status */
      }
    })()
    return () => {
      state.disposed = true
      // Flush, don't drop: ids collected right before a collapse or node
      // switch still deserve their refetch.
      flushInvalidates()
      state.sub?.close()
    }
  }, [collapsed, baseUrl, transportEpoch, queryClient])

  const applyAgentSettings = (
    sessionId: string,
    agent: AgentPreset,
    nodeUrl: string,
    opts?: { replace?: boolean },
  ): void => {
    chatSettings.set(`${nodeUrl}::${sessionId}`, {
      agent: agent.model || '',
      effort: agent.effort,
      systemPrompt: agent.systemPrompt || '',
    })
    setAgentLastSession(agent.id, sessionId, nodeUrl, opts)
  }

  // Hub connection stays put. The session lives on agent.nodeBaseUrl.
  const openFresh = (agent: AgentPreset, opts?: { replace?: boolean }): void => {
    const nodeUrl = agent.nodeBaseUrl
    const currentBase = useConnection.getState().baseUrl
    const sessionId = uuidv4()
    applyAgentSettings(sessionId, agent, nodeUrl, opts)
    setSessionNodeBinding(sessionId, nodeUrl, currentBase)
    addDraft(sessionId)
    setActive(sessionId)
    void navigate({ to: '/', search: { session: sessionId } })
    void queryClient.invalidateQueries({ queryKey: ['agent-session-status', agent.id] })
  }

  const openKept = (sessionId: string): void => {
    setActive(sessionId)
    void navigate({ to: '/', search: { session: sessionId } })
  }

  // Deciding fresh-vs-keep: a wrong "true" reopens a dead thread (harmless —
  // history still renders), a wrong "false" silently abandons a live one. So
  // only a definitive miss (control plane 404 AND absent from the on-disk
  // store scan) answers false; transient errors keep the pointer.
  /** 'dead' ONLY on a definitive miss: control-plane 404 AND absent from the
   *  on-disk scan. Every transport-shaped failure is 'unreachable' — the walk
   *  must stop there and open THAT thread (attach retries/banners), never
   *  fall through to an older candidate because the newest node blinked. */
  const probeSession = async (
    sessionId: string,
    nodeBaseUrl: string,
  ): Promise<'alive' | 'dead' | 'unreachable'> => {
    if (isUnclaimedDraft(sessionId) || knownToChatStore(sessionId)) return 'alive'
    let gw
    try {
      gw = await gatewayFor(nodeBaseUrl)
    } catch {
      return 'unreachable'
    }
    try {
      await gw.getHarnessSession(sessionId)
      return 'alive'
    } catch (err) {
      if (!(err instanceof GatewayError) || err.status !== 404) return 'unreachable'
    }
    try {
      const listed = await gw.harnessSessions()
      const match = listed.sessions.find((se) =>
        sessionPointerMatches(sessionId, se.id, nativeIdOf),
      )
      if (!match) return 'dead'
      if (match.id !== sessionId) {
        rekeyAgentLastSessions(sessionId, match.id)
        rekeySessionNodeBinding(sessionId, match.id)
      }
      return 'alive'
    } catch {
      return 'unreachable'
    }
  }

  // One generation per agent per click/start-over: a stale completion
  // (double-click, start-over racing a slow liveness probe, node switched
  // mid-await) must not navigate or mint a second draft — and one agent's
  // click must not cancel another's in-flight open.
  const openGen = useRef(new Map<string, number>())

  const bumpGen = (agentId: string): number => {
    const gen = (openGen.current.get(agentId) ?? 0) + 1
    openGen.current.set(agentId, gen)
    return gen
  }

  const handleOpen = (agent: RosterAgent): void => {
    if (!uniqueNodes.some((n) => n.baseUrl === agent.nodeBaseUrl)) return
    const gen = bumpGen(agent.id)
    void (async () => {
      collapseAgentSlots(agent.id, agent.nodeBaseUrl)
      const pin = listAgentSessions(agent.id)[0]
      if (!pin) {
        openFresh(agent)
        return
      }
      const verdict = await probeSession(pin.sessionId, pin.nodeBaseUrl)
      if (gen !== openGen.current.get(agent.id)) return
      if (verdict === 'dead') {
        clearAgentSessionPointer(agent.id, pin.nodeBaseUrl, pin.sessionId)
        clearSessionNodeBinding(pin.sessionId)
        openFresh(agent, { replace: true })
        return
      }
      const base = useConnection.getState().baseUrl
      const fresh = listAgentSessions(agent.id)[0] ?? pin
      setSessionNodeBinding(fresh.sessionId, fresh.nodeBaseUrl, base)
      openKept(fresh.sessionId)
    })()
  }

  const handleStartOver = (agent: RosterAgent): void => {
    bumpGen(agent.id)
    openFresh(agent, { replace: true })
  }

  return (
    <div className="border-t border-line px-2 py-2">
      {dialog.element}
      <div className="flex w-full items-center justify-between px-1 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex min-w-0 flex-1 items-center rounded px-3 py-2 text-sm text-ink-dim hover:bg-panel-2 hover:text-ink"
        >
          <Bot className="mr-2 size-4 shrink-0" aria-hidden />
          <span>Agents</span>
          {collapsed ? (
            <ChevronRight className="ml-1 size-3 text-ink-dim" />
          ) : (
            <ChevronDown className="ml-1 size-3 text-ink-dim" />
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
              nodeKnown={uniqueNodes.some((n) => n.baseUrl === agent.nodeBaseUrl)}
              onOpen={() => handleOpen(agent)}
              onStartOver={() => handleStartOver(agent)}
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
