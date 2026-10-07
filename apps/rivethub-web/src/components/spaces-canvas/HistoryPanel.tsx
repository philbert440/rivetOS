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
import { useAgentFilter } from '../../stores/agent-filter.js'
import { useArchived } from '../../stores/archived.js'
import { useConnection } from '../../stores/connection.js'
import { useSpaces } from '../../stores/spaces.js'
import { DrawerItem, isRowArchived, rowMembershipKey, selectDrawerItems } from '../drawer-item.js'

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
}): JSX.Element | null {
  const baseUrl = useConnection((s) => s.baseUrl)
  const archivedKeys = useArchived((s) => s.keys)
  const archive = useArchived((s) => s.archive)
  const unarchive = useArchived((s) => s.unarchive)
  const membership = useSpaces((s) => s.membership)
  const agentId = useAgentFilter((s) => s.agentId)
  const [showArchived, setShowArchived] = useState(false)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())

  const unplaced = (item: ChatItem): boolean => {
    const key = rowMembershipKey(baseUrl, item)
    return !Object.hasOwn(membership, key)
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
            if (target instanceof Element && target.closest('button[aria-label]')) return
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
      className="absolute inset-y-0 left-0 z-30 flex w-60 flex-col border border-line bg-panel font-mono"
      style={{
        outline: props.highlighted ? '2px solid var(--color-em)' : undefined,
      }}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-3">
        <span className="text-xs text-ink-dim">
          {props.pick ? props.pick.title : `History (${String(listed.length)})`}
        </span>
        {props.pick ? (
          <button
            type="button"
            onClick={props.pick.onCancel}
            className="border border-line px-2 py-1 text-xs text-ink-dim hover:border-em hover:text-em"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => startNewConversation()}
            className="border border-line px-2 py-1 text-xs text-ink-dim hover:border-em hover:text-em"
          >
            + new
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {renderNodes(forest)}
        {listed.length === 0 && (
          <div className="px-2 py-2 text-xs text-ink-dim">nothing in History</div>
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
