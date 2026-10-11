/**
 * History is the unplaced bucket: the same rows the session drawer lists,
 * minus threads that belong to a space. Opening a row does not place it.
 */

import {
  useEffect,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  ancestorChatKeys,
  nestChatItems,
  type ChatItem,
  type ChatNode,
} from '../../lib/harness-chat.js'
import { discardDraft } from '../../lib/discard-session.js'
import { storageKey } from '../../lib/session-rekey.js'
import { startNewConversation } from '../../lib/new-conversation.js'
import { X } from 'lucide-react'
import { SplitHandle } from '../split-handle.js'
import { useAgentFilter } from '../../stores/agent-filter.js'
import { useArchived } from '../../stores/archived.js'
import { useConnection } from '../../stores/connection.js'
import { useSpaces } from '../../stores/spaces.js'
import { DrawerItem, isRowArchived, rowMembershipKey, selectDrawerItems } from '../drawer-item.js'

export const HISTORY_WIDTH_DEFAULT = 240
export const HISTORY_WIDTH_MIN = 240
export const HISTORY_WIDTH_MAX = 720
const HISTORY_WIDTH_KEY = 'rivethub.canvas.historyWidth'

/** Saved History width, clamped; the default when unset or unreadable. */
export function loadHistoryWidth(): number {
  try {
    const raw = Number(localStorage.getItem(HISTORY_WIDTH_KEY))
    if (!raw) return HISTORY_WIDTH_DEFAULT
    return Math.min(HISTORY_WIDTH_MAX, Math.max(HISTORY_WIDTH_MIN, Math.round(raw)))
  } catch {
    return HISTORY_WIDTH_DEFAULT
  }
}

export function saveHistoryWidth(width: number): void {
  try {
    localStorage.setItem(HISTORY_WIDTH_KEY, String(width))
  } catch {
    /* storage disabled */
  }
}

export function HistoryPanel(props: {
  items: ChatItem[]
  active?: string
  open: boolean
  highlighted: boolean
  panelRef: RefObject<HTMLElement | null>
  /** Pick mode: place the chosen row into a space. Cancel writes nothing. */
  pick?: { title: string; onCancel: () => void }
  onOpen: (id: string) => void
  onDragPointerDown: (event: ReactPointerEvent<HTMLDivElement>, item: ChatItem) => void
  /** Panel width in px; the left-edge handle resizes it. */
  width: number
  onResize: (width: number) => void
  onCommitWidth: (width: number) => void
}): JSX.Element | null {
  const baseUrl = useConnection((s) => s.baseUrl)
  const archivedKeys = useArchived((s) => s.keys)
  const archive = useArchived((s) => s.archive)
  const unarchive = useArchived((s) => s.unarchive)
  const membership = useSpaces((s) => s.membership)
  const spaces = useSpaces((s) => s.spaces)
  const agentId = useAgentFilter((s) => s.agentId)
  const agentName = useAgentFilter((s) => s.name)
  const agentAccent = useAgentFilter((s) => s.accent)
  const clearAgent = useAgentFilter((s) => s.clear)
  const [showArchived, setShowArchived] = useState(false)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())

  const unplaced = (item: ChatItem): boolean => {
    const key = rowMembershipKey(baseUrl, item, membership)
    if (!Object.hasOwn(membership, key)) return true
    const spaceId = membership[key]
    return !spaces.some((space) => space.id === spaceId)
  }

  const listed = selectDrawerItems({
    items: props.items,
    active: props.active,
    showArchived,
    archivedKeys,
    baseUrl,
    agentId,
  }).filter(unplaced)

  const forest = nestChatItems(listed)
  const activePath = ancestorChatKeys(forest, props.active).join('\0')
  useEffect(() => {
    if (!activePath) return
    setOpenGroups((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const key of activePath.split('\0')) {
        if (!next.has(key)) {
          next.add(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [activePath])

  if (!props.open) return null

  const archivedCount = selectDrawerItems({
    items: props.items,
    active: props.active,
    showArchived: true,
    archivedKeys,
    baseUrl,
    agentId,
  }).filter((item) => unplaced(item) && isRowArchived(item, archivedKeys, baseUrl)).length

  const toggleNest = (key: string): void => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderNodes = (nodes: ChatNode[], depth = 0): JSX.Element[] =>
    nodes.map((node) => {
      const kids = node.children.length
      const expanded = kids > 0 && openGroups.has(node.item.key)
      const it = node.item
      const base = it.pinNodeBaseUrl ?? baseUrl
      return (
        <div
          key={it.key}
          data-drag-source="history"
          data-history-row={it.key}
          onPointerDown={(event) => {
            const target = event.target
            if (!(target instanceof Element)) return
            if (target.closest('button[aria-label]')) return
            // A nested row sits inside its ancestor's wrapper. Only the nearest
            // row may arm a drag; otherwise the ancestor overwrites it.
            if (target.closest('[data-history-row]') !== event.currentTarget) return
            event.stopPropagation()
            props.onDragPointerDown(event, it)
          }}
        >
          <DrawerItem
            item={it}
            active={it.key === props.active}
            archived={isRowArchived(it, archivedKeys, baseUrl)}
            onSelect={() => props.onOpen(it.key)}
            onArchive={() => archive(storageKey(base, it.key))}
            onUnarchive={() => unarchive(storageKey(base, it.key))}
            onDiscard={
              it.kind === 'draft' && !it.pin ? () => discardDraft(base, it.key) : undefined
            }
            childCount={kids}
            expanded={expanded}
            onToggleNest={kids > 0 ? () => toggleNest(it.key) : undefined}
            nested={depth > 0}
            tokenAccent
          />
          {expanded && <div className="pl-3">{renderNodes(node.children, depth + 1)}</div>}
        </div>
      )
    })

  return (
    <aside
      ref={props.panelRef}
      id="history-panel"
      data-history-panel=""
      aria-label={props.pick ? props.pick.title : 'History'}
      data-history-mode={props.pick ? 'pick' : 'browse'}
      className="absolute inset-y-0 right-0 z-30 flex flex-col border border-line bg-panel material:rounded-2xl material:border-line/40 material:shadow-pop"
      style={{
        width: props.width,
        outline: props.highlighted ? '2px solid var(--color-em)' : undefined,
      }}
    >
      {/* Drag the left edge to widen History; double-click resets. */}
      <SplitHandle
        edge="left"
        width={props.width}
        min={HISTORY_WIDTH_MIN}
        max={HISTORY_WIDTH_MAX}
        label="resize History"
        onResize={props.onResize}
        onCommit={props.onCommitWidth}
        onReset={() => props.onCommitWidth(HISTORY_WIDTH_DEFAULT)}
        className="absolute inset-y-0 -left-0.5 z-10"
      />
      <div className="flex items-center justify-between border-b border-line px-3 py-3">
        <span className="text-xs text-ink-dim">
          {props.pick ? props.pick.title : `History (${String(listed.length)})`}
        </span>
        {props.pick ? (
          <button
            type="button"
            onClick={props.pick.onCancel}
            className="border border-line px-2 py-1 text-xs text-ink-dim hover:bg-ink/6 hover:text-em classic:hover:bg-transparent classic:hover:border-em material:rounded-pill"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => startNewConversation()}
            className="border border-line px-2 py-1 text-xs text-ink-dim hover:bg-ink/6 hover:text-em classic:hover:bg-transparent classic:hover:border-em material:rounded-pill"
          >
            + new
          </button>
        )}
      </div>
      {/* History follows the sidebar's selected agent, like the
          conversations list. Say so, with a one-click way back to all of it:
          a quiet filter reads as "History is missing my threads". */}
      {agentId && !props.pick ? (
        <div data-history-filter="" className="px-3 pt-2">
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-ink classic:bg-panel classic:px-2 classic:py-0.5 classic:text-[11px]">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: agentAccent }}
              aria-hidden
            />
            <span className="min-w-0 truncate">Only {agentName ?? 'this agent'}</span>
            <button
              type="button"
              onClick={() => clearAgent()}
              aria-label="Show all of History"
              title="Show all of History"
              className="shrink-0 text-ink-dim hover:text-em"
            >
              <X className="size-3" />
            </button>
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {renderNodes(forest)}
        {listed.length === 0 && (
          <div className="px-2 py-2 text-xs text-ink-dim">
            {agentId
              ? `nothing from ${agentName ?? 'this agent'} in History`
              : 'nothing in History'}
          </div>
        )}
      </div>
      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((value) => !value)}
          className="border-t border-line px-3 py-2 text-left text-[11px] text-ink-dim hover:text-ink"
        >
          {showArchived ? '▾' : '▸'} archived ({archivedCount})
        </button>
      )}
    </aside>
  )
}
