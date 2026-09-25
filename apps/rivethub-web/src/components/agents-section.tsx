/**
 * Agents section — collapsible named agent presets roster for the sidebar.
 * Each agent carries model, effort, system prompt, color, and a target node.
 * Click opens that agent's sticky session on the resolved hosting den
 * without switchTo; ↺ replaces the pin. Hub connection, Memory, Files stay put.
 *
 * All node calls go through gatewayFor (desktop mTLS pipe, #491) — a raw
 * RivetGateway on an https base cannot authenticate from the desktop shell.
 */

import { Fragment, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Bot, ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { migrateAgentPreset, type HarnessId } from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { healthzQueryOptions, useMeshNodeName, useNodeName, urlLabel } from '../lib/node-name.js'
import { useNodeDiscovery } from '../lib/use-node-discovery.js'
import { agentDirectoryPlaceholder } from '../lib/agent-directory.js'
import {
  agentUpdateBody,
  catalogNameClashes,
  createWithLegacyRetry,
  type AgentWrite,
} from '../lib/agent-form.js'
import { useConfirmDialog } from './confirm-dialog.js'
import { Select } from './select.js'
import {
  agentCopySeed,
  canOfferAgentCopy,
  copyFormDirectory,
  copyName,
  type AgentDraft,
} from '../lib/agent-copy.js'
import { gatewayFor } from '../lib/agent-gateway.js'
import {
  defaultEffort,
  defaultModel,
  effortOptionsFor,
  harnessLabel,
  modelOptionsFor,
} from '../lib/harness-options.js'
import { rosterCommandFor } from '../lib/harness-chat.js'
import { uuidv4 } from '../lib/uuid.js'
import {
  agentForSession,
  clearAgentLastSession,
  clearAgentSessionPointer,
  collapseAgentSlots,
  listAgentSessions,
  rekeyAgentLastSessions,
  setAgentLastSession,
} from '../lib/agent-session.js'
import {
  agentDeleteTarget,
  agentThreadSettings,
  agentUpdateTarget,
  aggregateAgentActivity,
  dedupeRosterAgents,
  meshDenName,
  nodeOptionLabel,
  pointersToPoll,
  sessionPointerMatches,
  uniqueRosterNodes,
  type ListedAgents,
  type NodeChoice,
  type ResolvedRosterAgent,
} from '../lib/agent-roster.js'
import {
  applyPendingOrder,
  moveAgentId,
  sortOrderWrites,
  sortRosterAgents,
} from '../lib/agent-order.js'
import { nativeIdOf } from '../lib/harness-chat.js'
import { accentFor } from '../lib/agent-accent.js'
import {
  clearSessionNodeBinding,
  rekeySessionNodeBinding,
  setSessionNodeBinding,
} from '../lib/session-node.js'
import { useChat } from '../stores/chat.js'
import { useChatSettings } from '../stores/chat-settings.js'
import { useSidebarPrefs } from '../stores/sidebar-prefs.js'
import { Tooltip } from './ui/tooltip.js'

type RosterAgent = ResolvedRosterAgent

type NodeListMeta = {
  node?: string
  directoryRoot?: string
  sharedDir?: string
  backend?: 'postgres' | 'file'
}

const nodeListMeta = new Map<string, NodeListMeta>()
const lastGoodSliceByNode = new Map<string, ListedAgents & NodeListMeta>()

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

interface NodeSelectorProps {
  value: string
  onChange: (baseUrl: string) => void
  disabled?: boolean
  excludedNodes?: string[]
}

function NodeSelector({
  value,
  onChange,
  disabled,
  excludedNodes = [],
}: NodeSelectorProps): JSX.Element {
  const { roster, baseUrl: currentBaseUrl } = useConnection()
  const { mesh } = useNodeDiscovery()
  const meshNodes = mesh.data?.nodes ?? []
  const rosterNodes = uniqueRosterNodes(roster, currentBaseUrl)
  const uniqueNodes =
    value && !rosterNodes.some((n) => n.baseUrl === value)
      ? [...rosterNodes, { name: value, baseUrl: value }]
      : rosterNodes
  const probes = useQueries({ queries: uniqueNodes.map((n) => healthzQueryOptions(n.baseUrl)) })
  const options = uniqueNodes
    .map((n, i) => ({
      value: n.baseUrl,
      label: nodeOptionLabel(n, {
        currentBaseUrl,
        meshName: meshDenName(meshNodes, n.baseUrl),
        healthzNode: probes[i]?.data?.node || undefined,
      }),
    }))
    .filter((n) => !excludedNodes.includes(n.value))

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-ink-dim">Node</label>
      <Select
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        label="Node"
        className="w-full"
      />
    </div>
  )
}

interface AgentEditorProps {
  agent?: RosterAgent
  duplicate?: { source: RosterAgent; draft: AgentDraft }
  onSave: (agent: AgentWrite) => void
  onCancel: () => void
  onDuplicate?: (draft: AgentDraft) => void
  disabled?: boolean
  errorText?: string
}

function AgentEditor({
  agent,
  duplicate,
  onSave,
  onCancel,
  onDuplicate,
  disabled,
  errorText,
}: AgentEditorProps): JSX.Element {
  const { baseUrl, roster, transportEpoch } = useConnection()
  const init = agent ?? duplicate?.draft
  const [name, setName] = useState(duplicate ? copyName(duplicate.draft.name) : (init?.name ?? ''))
  const [color, setColor] = useState(init?.color ?? '')
  const [rawHarnessId, setHarnessId] = useState(init?.harnessId ?? '')
  const [rawModel, setModel] = useState(init?.model ?? '')
  const [rawEffort, setEffort] = useState(init?.effort ?? '')
  const [systemPrompt, setSystemPrompt] = useState(init?.systemPrompt ?? '')
  const [draftDirectory, setDirectory] = useState(
    agent?.directory ?? duplicate?.draft.directory ?? '',
  )
  const [sharedLink, setSharedLink] = useState(
    agent?.sharedLink ?? duplicate?.draft.sharedLink ?? true,
  )
  const excludedNodes = duplicate ? [duplicate.source.sourceNodeBaseUrl] : []
  const [nodeBaseUrl, setNodeBaseUrl] = useState(
    agent?.sourceNodeBaseUrl ??
      (duplicate
        ? (uniqueRosterNodes(roster, baseUrl).find((n) => !excludedNodes.includes(n.baseUrl))
            ?.baseUrl ?? '')
        : baseUrl),
  )
  const nodeLocked = Boolean(agent)
  const hostingNode = useMeshNodeName(agent?.sourceNodeBaseUrl ?? '')
  const directoryRoot = nodeListMeta.get(nodeBaseUrl)?.directoryRoot
  const catalogQuery = useQuery({
    queryKey: ['agent-catalog', nodeBaseUrl, transportEpoch],
    queryFn: async ({ signal }) => (await gatewayFor(nodeBaseUrl)).catalog(signal),
    enabled: Boolean(nodeBaseUrl),
    staleTime: 60_000,
    retry: false,
  })
  const trimmedName = name.trim()
  const catalogClash = catalogNameClashes(trimmedName, catalogQuery.data?.agents ?? [], agent?.id)
  const formRef = useRef<HTMLFormElement | null>(null)
  // A picker's Radix popper still being mounted means that popover owns the
  // event (its own dismiss handlers run first, in the same dispatch).
  const pickerOpen = (): boolean =>
    document.querySelector('[data-radix-popper-content-wrapper]') !== null
  // Only a press that STARTED on the backdrop (with no picker open) may
  // cancel — dismissing a picker by clicking outside must not also land on
  // the backdrop and unmount the editor, losing the draft.
  const backdropArmed = useRef(false)

  const harnessesQuery = useQuery({
    queryKey: ['harnesses', nodeBaseUrl, transportEpoch],
    queryFn: async ({ signal }) => (await gatewayFor(nodeBaseUrl)).harnesses(signal),
    staleTime: duplicate ? 0 : 60_000,
    enabled: Boolean(nodeBaseUrl),
  })
  const harnesses = harnessesQuery.data?.harnesses ?? []
  const copy =
    duplicate && nodeBaseUrl && !excludedNodes.includes(nodeBaseUrl)
      ? agentCopySeed(
          {
            name,
            color,
            systemPrompt,
            harnessId: rawHarnessId,
            model: rawModel,
            effort: rawEffort,
            directory: draftDirectory,
            sharedLink,
          },
          {
            ...duplicate.source,
            directoryRoot:
              nodeListMeta.get(duplicate.source.sourceNodeBaseUrl)?.directoryRoot ??
              nodeListMeta.get(duplicate.source.listedBaseUrl)?.directoryRoot,
          },
          { nodeBaseUrl, harnesses },
        )
      : undefined
  const harnessId = duplicate ? (copy?.seed.harnessId ?? '') : rawHarnessId
  const model = duplicate ? (copy?.seed.model ?? '') : rawModel
  const effort = duplicate ? (copy?.seed.effort ?? '') : rawEffort
  // The copy form shows and submits the seed directory. A source default
  // that `agentCopySeed` dropped must not ride along as the draft path.
  const directory = duplicate ? copyFormDirectory(draftDirectory, copy?.seed) : draftDirectory
  const copyReady =
    !duplicate ||
    Boolean(copy && harnessesQuery.isSuccess && !harnessesQuery.isFetching && harnessId)
  const offerCopy = canOfferAgentCopy(agent, nodeBaseUrl, harnessesQuery.isError)
  const sheet = harnesses.find((h) => h.harnessId === harnessId)?.capabilities
  const models = modelOptionsFor(sheet)
  if (!duplicate && model && !models.some((o) => o.value === model)) {
    models.unshift({ value: model, label: model })
  }
  const efforts = effortOptionsFor(sheet, model)
  if (!duplicate && effort && !efforts.some((o) => o.value === effort)) {
    efforts.unshift({ value: effort, label: effort })
  }
  const harnessOptions: { value: string; label: string }[] = harnesses.map((h) => ({
    value: h.harnessId,
    label: harnessLabel(h.harnessId),
  }))
  if (!duplicate && harnessId && !harnessOptions.some((o) => o.value === harnessId)) {
    harnessOptions.unshift({ value: harnessId, label: harnessLabel(harnessId) })
  }

  useEffect(() => {
    if (agent || duplicate || harnessId || harnesses.length === 0) return
    const first = harnesses[0].harnessId
    setHarnessId(first)
    const firstSheet = harnesses[0].capabilities
    const m = defaultModel(firstSheet)
    setModel(m)
    setEffort(defaultEffort(firstSheet, m))
  }, [agent, duplicate, harnessId, harnesses])

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
    if (!copyReady) return
    const patch: AgentWrite = {
      name,
      color,
      model,
      effort,
      systemPrompt,
      harnessId: harnessId ? (harnessId as HarnessId) : null,
      directory,
      sharedLink,
    }
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
        aria-label={agent ? 'Edit agent' : duplicate ? 'Copy agent' : 'New agent'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="flex max-h-[85vh] w-96 flex-col gap-3 overflow-y-auto rounded-md border border-line bg-panel p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-em">
            {agent ? 'Edit Agent' : duplicate ? 'Copy Agent' : 'New Agent'}
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
          {catalogClash && (
            <p className="text-xs text-ink-dim" role="status">
              This name matches a catalog agent id, which wins over a preset name for delegate_task.
            </p>
          )}
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

        {agent ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-ink-dim">Node</span>
            <p className="rounded border border-line bg-panel-2 px-2 py-1.5 text-xs text-ink">
              {agent.node || hostingNode || 'unknown'}
            </p>
          </div>
        ) : (
          <NodeSelector
            excludedNodes={excludedNodes}
            value={nodeBaseUrl}
            onChange={setNodeBaseUrl}
            disabled={disabled}
          />
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-dim">Directory</label>
          <input
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder={agentDirectoryPlaceholder(directoryRoot, name)}
            disabled={disabled}
            spellCheck={false}
            className="rounded border border-line bg-panel-2 px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-em disabled:opacity-50"
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={sharedLink}
            onChange={(e) => setSharedLink(e.target.checked)}
            disabled={disabled}
          />
          Link shared directory (rivet-shared)
        </label>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-dim">Harness</label>
          <Select
            value={harnessId}
            options={harnessOptions}
            onChange={(id) => {
              setHarnessId(id)
              const next = harnesses.find((h) => h.harnessId === id)?.capabilities
              const m = defaultModel(next)
              setModel(m)
              setEffort(defaultEffort(next, m))
            }}
            disabled={disabled || harnessesQuery.isError}
            title={
              harnessesQuery.isError ? `Couldn't load harnesses from ${nodeBaseUrl}` : undefined
            }
            label="Harness"
            className="w-full"
          />
          {harnessesQuery.isError && (
            <div role="status" className="flex flex-col gap-1.5">
              <span className="text-xs text-red">
                Couldn't load harnesses from {nodeBaseUrl}.
                {offerCopy
                  ? " Saving also needs a successful connection to this node. A preset's node cannot be changed. You can create a copy on another reachable node; the original stays on its node and can be deleted when that node is reachable again."
                  : agent
                    ? ' Saving requires a connection to the preset’s node.'
                    : ' Pick another node or retry when this node is reachable.'}
              </span>
              {offerCopy && onDuplicate && (
                <button
                  type="button"
                  onClick={() =>
                    onDuplicate({
                      name,
                      color,
                      harnessId,
                      model,
                      effort,
                      systemPrompt,
                      directory,
                      sharedLink,
                    })
                  }
                  disabled={disabled}
                  className="self-start rounded border border-line px-3 py-1.5 text-xs text-ink-dim hover:border-em hover:text-em disabled:opacity-50"
                >
                  Copy to another node…
                </button>
              )}
            </div>
          )}
          {duplicate && (
            <div role="status" className="text-xs text-ink-dim">
              Create a copy on a reachable node. The original preset and its history stay on the
              original node; delete that preset when its node is reachable again.
              {!nodeBaseUrl && <p>Add another node to the roster to create a copy.</p>}
              {harnessesQuery.isSuccess && !harnessesQuery.isFetching && (
                <>
                  {copy?.notes.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                  {!harnessId && <p>This target offers no harnesses. Choose another node.</p>}
                </>
              )}
            </div>
          )}
        </div>

        {models.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-dim">Model</label>
            <Select
              value={model}
              options={models}
              onChange={(id) => {
                setHarnessId(harnessId)
                setModel(id)
                setEffort(defaultEffort(sheet, id))
              }}
              disabled={disabled}
              label="Model"
              className="w-full"
            />
          </div>
        )}

        {efforts.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-dim">Effort</label>
            <Select
              value={effort}
              options={efforts}
              onChange={(id) => {
                setHarnessId(harnessId)
                setModel(model)
                setEffort(id)
              }}
              disabled={disabled}
              label="Effort"
              className="w-full"
            />
          </div>
        )}

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

        {errorText && (
          <div role="alert" className="text-xs text-red">
            {errorText}
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={
              !copyReady ||
              !name.trim() ||
              disabled ||
              (color.trim() !== '' && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color.trim()))
            }
            className="flex-1 rounded bg-em px-3 py-1.5 text-xs font-semibold text-bg hover:opacity-90 disabled:opacity-50"
          >
            {agent ? 'Update' : duplicate ? 'Create copy' : 'Create'}
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
  compact?: boolean
  onOpen: () => void
  onStartOver: () => void
  onEdit: () => void
  onDelete: () => void
}

function AgentRow({
  agent,
  nodeKnown,
  compact,
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
                if (scanErr instanceof DOMException && scanErr.name === 'AbortError') {
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
  const place = [agent.node, agent.directory].filter(Boolean).join(' · ')
  const rowTitle = nodeKnown
    ? place
      ? `${agent.name} — ${place}`
      : agent.name
    : place
      ? `${agent.name} (node unknown) — ${place}`
      : `${agent.name} (node unknown)`

  const swatch = (
    <span
      className={compact ? 'size-3 shrink-0 rounded-full' : 'size-2 shrink-0 rounded-full'}
      style={{
        background: accentFor({
          presetColor: agent.color,
          harnessId: agent.harnessId,
          command: rosterCommandFor(agent.harnessId) ?? agent.model,
        }),
      }}
      aria-hidden
    />
  )

  if (compact) {
    return (
      <Tooltip label={rowTitle} block>
        <button
          type="button"
          onClick={onOpen}
          disabled={!nodeKnown}
          aria-label={agent.name}
          className="flex w-full items-center justify-center rounded py-1.5 hover:bg-panel-2 disabled:opacity-50"
        >
          {swatch}
        </button>
      </Tooltip>
    )
  }

  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-panel-2">
      <button
        id={`agent-row-${agent.id}`}
        onClick={onOpen}
        disabled={!nodeKnown}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50"
        title={rowTitle}
      >
        {swatch}
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

function orderNodeLabel(
  agent: Pick<RosterAgent, 'node' | 'sourceNodeBaseUrl' | 'listedBaseUrl'>,
): string {
  const name = agent.node?.trim()
  if (name) return name
  const target = agentUpdateTarget(agent).trim()
  return target ? urlLabel(target) : 'node unknown'
}

function sameIdOrder(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((id, index) => id === b[index])
}

function storedSortKey(agents: readonly { id: string; sortOrder?: number }[]): string {
  return agents.map((agent) => `${agent.id}\0${agent.sortOrder ?? ''}`).join('\n')
}

/** `null` clears the order; the echoed preset then omits `sortOrder`. */
function sortOrderEcho(sent: number | null): number | undefined {
  return sent === null ? undefined : sent
}

export function AgentsSection(props: { compact?: boolean }): JSX.Element {
  const compact = props.compact ?? false
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { baseUrl, roster, transportEpoch } = useConnection()
  const { addDraft, setActive } = useChat()
  const chatSettings = useChatSettings()
  const [collapsed, setCollapsed] = useState(false)
  const [editing, setEditing] = useState<RosterAgent | null>(null)
  const [creating, setCreating] = useState(false)
  const [duplicating, setDuplicating] = useState<{ source: RosterAgent; draft: AgentDraft } | null>(
    null,
  )
  const dialog = useConfirmDialog()

  const uniqueNodes: NodeChoice[] = uniqueRosterNodes(roster, baseUrl)
  const { mesh } = useNodeDiscovery()
  const meshNodes = mesh.isError ? [] : (mesh.data?.nodes ?? [])
  const probes = useQueries({ queries: uniqueNodes.map((n) => healthzQueryOptions(n.baseUrl)) })
  const rosterForResolve: NodeChoice[] = uniqueNodes.map((n, i) => {
    const node = probes[i]?.data?.node || undefined
    return { name: n.name, baseUrl: n.baseUrl, ...(node ? { node } : {}) }
  })
  // Sorted roster URLs only. Healthz nodes and mesh aliases are applied when
  // deduping the cached lists, so a probe resolving does not refetch every den.
  const rosterUrlKey = uniqueNodes
    .map((n) => n.baseUrl.trim().replace(/\/+$/, ''))
    .filter((url) => url !== '')
    .sort()
    .join('|')

  const nodeQueries = useQuery({
    queryKey: ['agents-all-nodes', rosterUrlKey, transportEpoch],
    queryFn: async ({ signal }) => {
      const results = await Promise.all(
        uniqueNodes.map(async (node) => {
          try {
            const res = await (await gatewayFor(node.baseUrl)).agentsList(signal)
            const slice: ListedAgents & NodeListMeta = {
              baseUrl: node.baseUrl,
              node: res.node,
              directoryRoot: res.directoryRoot,
              sharedDir: res.sharedDir,
              backend: res.backend,
              agents: res.agents.map((agent) => migrateAgentPreset(agent)),
            }
            lastGoodSliceByNode.set(node.baseUrl, slice)
            nodeListMeta.set(node.baseUrl, slice)
            return slice
          } catch (err) {
            if (signal.aborted) throw err
            const kept = lastGoodSliceByNode.get(node.baseUrl)
            if (kept) {
              nodeListMeta.set(node.baseUrl, kept)
              return kept
            }
            return { baseUrl: node.baseUrl, agents: [] }
          }
        }),
      )
      return results
    },
    placeholderData: (prev) => prev,
  })

  const storedAgents = sortRosterAgents(
    dedupeRosterAgents(nodeQueries.data ?? [], {
      currentBaseUrl: baseUrl,
      mesh: meshNodes,
      roster: rosterForResolve,
    }),
  )
  // Optimistic order while a reorder saves. Cleared only when this save is
  // still the latest request; a queued save keeps the order on screen.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
  const agents = applyPendingOrder(storedAgents, pendingOrder)
  const isLoading = nodeQueries.isLoading

  // Latest sortOrder this client knows. Re-seeded from the query whenever no
  // save is pending, then updated from each successful PATCH so the next save
  // does not diff a stale snapshot.
  const knownSortOrder = useRef<Map<string, number | undefined>>(new Map())
  const latestRequested = useRef<string[] | null>(null)
  const savesPending = useRef(0)
  const seededFrom = useRef<string | null>(null)
  const focusRowId = useRef<string | null>(null)
  const storedKey = storedSortKey(storedAgents)
  if (savesPending.current === 0 && seededFrom.current !== storedKey) {
    seededFrom.current = storedKey
    knownSortOrder.current = new Map(storedAgents.map((agent) => [agent.id, agent.sortOrder]))
  }

  useEffect(() => {
    const id = focusRowId.current
    if (!id || pendingOrder === null) return
    document.getElementById(`agent-row-${id}`)?.focus()
    focusRowId.current = null
  }, [pendingOrder])

  const [dragId, setDragId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const reorderMutation = useMutation({
    scope: { id: 'agent-order' },
    mutationFn: async (orderedIds: string[]) => {
      const writes = sortOrderWrites(storedAgents, orderedIds, knownSortOrder.current)
      const settled = await Promise.allSettled(
        writes.map(async ({ agent, sortOrder }) => {
          const nodeLabel = orderNodeLabel(agent)
          let updated: { agent: { sortOrder?: number } }
          try {
            updated = await (
              await gatewayFor(agentUpdateTarget(agent))
            ).agentUpdate(agent.id, { sortOrder })
          } catch (err) {
            const message = err instanceof Error ? err.message : 'request failed'
            throw new Error(`${nodeLabel}: ${message}`, { cause: err })
          }
          const echoed = updated.agent.sortOrder
          if (echoed !== sortOrderEcho(sortOrder)) {
            throw new Error(`${nodeLabel} does not support agent ordering (update that den)`)
          }
          knownSortOrder.current.set(agent.id, echoed)
        }),
      )
      const failed = settled.flatMap((result) =>
        result.status === 'rejected'
          ? [result.reason instanceof Error ? result.reason.message : 'request failed']
          : [],
      )
      if (failed.length > 0) throw new Error(failed.join('; '))
    },
    onSettled: async (_data, _err, orderedIds) => {
      try {
        await queryClient.invalidateQueries({ queryKey: ['agents-all-nodes'] })
      } finally {
        savesPending.current -= 1
        if (sameIdOrder(latestRequested.current, orderedIds)) setPendingOrder(null)
      }
    },
  })
  const reorder = (id: string, toIndex: number, restoreFocus = false): void => {
    const current = agents.map((agent) => agent.id)
    const next = moveAgentId(current, id, toIndex)
    if (next.every((value, i) => value === current[i])) return
    if (restoreFocus) focusRowId.current = id
    latestRequested.current = next
    savesPending.current += 1
    setPendingOrder(next)
    reorderMutation.mutate(next)
  }
  const endDrag = (): void => {
    setDragId(null)
    setDropIndex(null)
  }

  const createMutation = useMutation({
    mutationFn: async (agent: AgentWrite) => {
      const target = agent.nodeBaseUrl
      if (!target) throw new Error('node unknown')
      const gw = await gatewayFor(target)
      // Old dens still 400 when nodeBaseUrl is missing. One retry; a second
      // failure is the mutation error. New fields are ignored by those dens.
      return createWithLegacyRetry((body) => gw.agentCreate(body), agent, target)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents-all-nodes'] })
      setCreating(false)
      setDuplicating(null)
    },
  })

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      agent,
      targetNode,
      previous,
    }: {
      id: string
      agent: AgentWrite
      targetNode: string
      previous: RosterAgent
    }) => (await gatewayFor(targetNode)).agentUpdate(id, agentUpdateBody(previous, agent)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents-all-nodes'] })
      setEditing(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async ({ id, targetNode }: { id: string; targetNode: string }) =>
      (await gatewayFor(targetNode)).agentDelete(id),
    onSuccess: (_result, { id }) => {
      clearAgentLastSession(id)
      void queryClient.invalidateQueries({ queryKey: ['agents-all-nodes'] })
    },
  })

  // Stable cancel handlers — the editor's document keydown effect depends on
  // onCancel, so an inline lambda would resubscribe it every parent render.
  const { reset: resetCreate } = createMutation
  const { reset: resetUpdate } = updateMutation
  const cancelCreate = useCallback(() => {
    setCreating(false)
    setDuplicating(null)
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
    agent: RosterAgent,
    nodeUrl: string,
    opts?: { replace?: boolean },
  ): void => {
    chatSettings.set(`${nodeUrl}::${sessionId}`, agentThreadSettings(agent))
    setAgentLastSession(agent.id, sessionId, nodeUrl, opts)
  }

  // Hub connection stays put. The session lives on the resolved hosting URL.
  // sourceNodeBaseUrl is empty when that URL is not a roster entry, so this
  // never pins a session to an off-roster host.
  const openFresh = (agent: RosterAgent, opts?: { replace?: boolean }): void => {
    const nodeUrl = agent.sourceNodeBaseUrl
    if (!nodeUrl) return
    const currentBase = useConnection.getState().baseUrl
    const sessionId = uuidv4()
    applyAgentSettings(sessionId, agent, nodeUrl, opts)
    setSessionNodeBinding(sessionId, nodeUrl, currentBase)
    addDraft(sessionId)
    setActive(sessionId)
    useSidebarPrefs.getState().setDrawerOpen(false)
    void navigate({ to: '/', replace: true })
    void queryClient.invalidateQueries({ queryKey: ['agent-session-status', agent.id] })
  }

  const openKept = (sessionId: string): void => {
    setActive(sessionId)
    useSidebarPrefs.getState().setDrawerOpen(false)
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
    if (!agent.sourceNodeBaseUrl) return
    const gen = bumpGen(agent.id)
    void (async () => {
      collapseAgentSlots(agent.id, agent.sourceNodeBaseUrl)
      const pin = listAgentSessions(agent.id).at(0)
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
    // Same fail-closed guard as handleOpen: never mint/pin off-roster. The
    // spawn itself is already fail-closed at spawnPty; this keeps a ↺ click
    // from minting a draft pinned to a node that cannot run it.
    if (!agent.sourceNodeBaseUrl) return
    bumpGen(agent.id)
    openFresh(agent, { replace: true })
  }

  return (
    <div className={compact ? 'border-t border-line px-1 py-2' : 'border-t border-line px-2 py-2'}>
      {dialog.element}
      <div className="flex w-full items-center justify-between">
        <Tooltip label="Agents" disabled={!compact} block>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label="Agents"
            aria-expanded={!collapsed}
            className={
              compact
                ? 'flex w-full items-center justify-center rounded py-2 text-ink-dim hover:bg-panel-2 hover:text-ink'
                : 'flex min-w-0 flex-1 items-center rounded px-3 py-2 text-sm text-ink-dim hover:bg-panel-2 hover:text-ink'
            }
          >
            <Bot className={compact ? 'size-4 shrink-0' : 'mr-2 size-4 shrink-0'} aria-hidden />
            {!compact && <span>Agents</span>}
            {!compact &&
              (collapsed ? (
                <ChevronRight className="ml-1 size-3 text-ink-dim" />
              ) : (
                <ChevronDown className="ml-1 size-3 text-ink-dim" />
              ))}
          </button>
        </Tooltip>
        {!collapsed && !compact && (
          <button
            type="button"
            onClick={() => {
              setEditing(null)
              setDuplicating(null)
              resetCreate()
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
          {isLoading && !compact && <div className="px-2 text-xs text-ink-dim">loading…</div>}
          {!isLoading && agents.length === 0 && !creating && !duplicating && !compact && (
            <div className="px-2 text-xs text-ink-dim">no agents yet</div>
          )}
          {agents.map((agent, index) => {
            const row = (
              <AgentRow
                agent={agent}
                compact={compact}
                nodeKnown={Boolean(agent.sourceNodeBaseUrl)}
                onOpen={() => handleOpen(agent)}
                onStartOver={() => handleStartOver(agent)}
                onEdit={() => {
                  setCreating(false)
                  setDuplicating(null)
                  resetUpdate()
                  setEditing(agent)
                }}
                onDelete={() => {
                  void (async () => {
                    if (
                      await dialog.confirm(`Delete agent "${agent.name}"?`, {
                        danger: true,
                      })
                    ) {
                      deleteMutation.mutate({
                        id: agent.id,
                        targetNode: agentDeleteTarget(agent),
                      })
                    }
                  })()
                }}
              />
            )
            // Compact rows are not draggable. No wrapper classes or handlers —
            // a border here used to grow every row, including the rail.
            if (compact) return <Fragment key={agent.id}>{row}</Fragment>
            const showBefore = dropIndex === index
            const showAfter = dropIndex === index + 1 && index === agents.length - 1
            return (
              <div
                key={agent.id}
                draggable
                title="drag or Alt+↑/↓ to reorder"
                onDragStart={(e) => {
                  setDragId(agent.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', agent.id)
                }}
                onDragOver={(e) => {
                  if (dragId === null) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const rect = e.currentTarget.getBoundingClientRect()
                  setDropIndex(e.clientY > rect.top + rect.height / 2 ? index + 1 : index)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragId !== null && dropIndex !== null) {
                    const from = agents.findIndex((a) => a.id === dragId)
                    reorder(dragId, dropIndex > from ? dropIndex - 1 : dropIndex)
                  }
                  endDrag()
                }}
                onDragEnd={endDrag}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
                  e.preventDefault()
                  reorder(agent.id, index + (e.key === 'ArrowUp' ? -1 : 1), true)
                }}
                className={dragId === agent.id ? 'relative opacity-50' : 'relative'}
              >
                {showBefore && (
                  <span className="absolute inset-x-0 -top-px h-0.5 bg-em" aria-hidden />
                )}
                {showAfter && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-em" aria-hidden />
                )}
                {row}
              </div>
            )
          })}
        </div>
      )}

      {reorderMutation.error && (
        <div role="alert" className="px-2 text-xs text-red">
          Could not save agent order: {mutationError(reorderMutation.error)}
        </div>
      )}

      {deleteMutation.error && (
        <div role="alert" className="px-2 text-xs text-red">
          Could not delete preset: {mutationError(deleteMutation.error)}
        </div>
      )}

      {editing && (
        <AgentEditor
          agent={editing}
          onSave={(updated) =>
            updateMutation.mutate({
              id: editing.id,
              agent: updated,
              targetNode: agentUpdateTarget(editing),
              previous: editing,
            })
          }
          onCancel={cancelEdit}
          onDuplicate={(draft) => {
            const source = editing
            setEditing(null)
            resetUpdate()
            resetCreate()
            setDuplicating({ source, draft })
          }}
          disabled={updateMutation.isPending}
          errorText={updateMutation.error ? mutationError(updateMutation.error) : undefined}
        />
      )}
      {(creating || duplicating) && (
        <AgentEditor
          duplicate={duplicating ?? undefined}
          onSave={(agent) => createMutation.mutate(agent)}
          onCancel={cancelCreate}
          disabled={createMutation.isPending}
          errorText={createMutation.error ? mutationError(createMutation.error) : undefined}
        />
      )}
    </div>
  )
}
