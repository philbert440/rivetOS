/**
 * One conversation row from the session drawer, shared with the canvas
 * History panel so archive / rename / discard / pins / nesting stay one
 * implementation. `selectDrawerItems` is the drawer's agent + archive filter.
 */

import { useRef, useState, type JSX } from 'react'
import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react'
import { accentFor, harnessAccentKey, sameLabel } from '../lib/agent-accent.js'
import { rowOwnedByAgent } from '../lib/agent-session.js'
import { denRoomKey, nativeIdOf, shortNativeId, type ChatItem } from '../lib/harness-chat.js'
import { rowPillText } from '../lib/harness-options.js'
import { storageKey } from '../lib/session-rekey.js'
import { getSessionNodeBinding } from '../lib/session-node.js'
import { useConnection } from '../stores/connection.js'
import { useSessionNames } from '../stores/session-names.js'

/**
 * Read a thread's persisted value, falling back to the pre-canonical key.
 *
 * Names and per-thread settings were filed under the bare native id before
 * hub chat keyed on `SessionId`. Nothing is rewritten on upgrade: the read
 * falls back to the old key and the next write lands on the new one, so the
 * migration happens per conversation as it is used (§ Legacy keys — aliases
 * cover reads).
 */
export function persisted<T>(
  byKey: Record<string, T | undefined>,
  baseUrl: string,
  key: string,
): T | undefined {
  const own = byKey[storageKey(baseUrl, key)]
  if (own !== undefined) return own
  const native = denRoomKey(key)
  return native === key ? undefined : byKey[storageKey(baseUrl, native)]
}

export function isRowArchived(
  item: ChatItem,
  archivedKeys: readonly string[],
  baseUrl: string,
): boolean {
  return archivedKeys.includes(storageKey(item.pinNodeBaseUrl ?? baseUrl, item.key))
}

/**
 * The rows the session drawer lists: the selected agent's sessions (when the
 * rail has one), minus archived rows other than the open thread. History
 * starts from this set and then drops threads that belong to a space.
 */
export function selectDrawerItems(opts: {
  items: readonly ChatItem[]
  active?: string
  showArchived: boolean
  archivedKeys: readonly string[]
  baseUrl: string
  agentId?: string
}): ChatItem[] {
  const agentItems = opts.agentId
    ? opts.items.filter((it) => rowOwnedByAgent(it.key, opts.agentId ?? '', nativeIdOf))
    : [...opts.items]
  return agentItems.filter((it) => {
    if (
      !opts.showArchived &&
      isRowArchived(it, opts.archivedKeys, opts.baseUrl) &&
      it.key !== opts.active
    ) {
      return false
    }
    return true
  })
}

/**
 * Membership key for a drawer row. A pin names its node. An unpinned row
 * stays on the hub when that entry exists, or when nothing is bound — History
 * places there even if the session is also bound to another node. A node-only
 * space default is filed under the binding, which is the key adoption rekeys.
 *
 * `membership` is the caller's map. This does not read the spaces store, so a
 * snapshot passed into `buildCanvasRegions` cannot disagree with the lookup.
 */
export function rowMembershipKey(
  baseUrl: string,
  item: ChatItem,
  membership: Readonly<Record<string, string>>,
): string {
  if (item.pinNodeBaseUrl) return storageKey(item.pinNodeBaseUrl, item.key)
  const hubKey = storageKey(baseUrl, item.key)
  const binding = getSessionNodeBinding(item.key)
  if (!binding || binding === baseUrl) return hubKey
  const boundKey = storageKey(binding, item.key)
  if (Object.hasOwn(membership, hubKey) || !Object.hasOwn(membership, boundKey)) return hubKey
  return boundKey
}

/** One conversation row — shows the custom name (if set) over the derived
 *  title, with inline rename (pencil on hover → input; Enter/blur saves, empty
 *  clears, Escape cancels). Rename persists per node+session (localStorage).
 *  Control-plane rows also carry a harness badge (§ Session identity: "UI may
 *  badge harness + short native suffix"). */
export function DrawerItem(props: {
  item: ChatItem
  active: boolean
  archived: boolean
  onSelect: () => void
  onArchive: () => void
  onUnarchive: () => void
  /** Drafts only — a draft is local, so discarding it is a real delete. */
  onDiscard?: () => void
  /** Nested conversations under this row. 0 hides the disclosure. */
  childCount?: number
  expanded?: boolean
  onToggleNest?: () => void
  /** Child of another conversation. Label is the subagent type, with an elbow. */
  nested?: boolean
  /** Canvas History: harness token class, no inline hex. The drawer keeps accentFor. */
  tokenAccent?: boolean
}): JSX.Element {
  const hubBase = useConnection((s) => s.baseUrl)
  const storeBase = props.item.pinNodeBaseUrl ?? hubBase
  const key = storageKey(storeBase, props.item.key)
  const customName = useSessionNames((s) => persisted(s.byKey, storeBase, props.item.key))
  const setName = useSessionNames((s) => s.set)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Escape cancels; a blur can still fire as the input unmounts, so guard the
  // commit so Escape never saves (grok review).
  const cancelRef = useRef(false)

  if (editing) {
    const commit = (): void => {
      if (cancelRef.current) {
        cancelRef.current = false
        setEditing(false)
        return
      }
      setName(key, draft)
      setEditing(false)
    }
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          commit()
        }}
        className="mb-1 flex items-center rounded bg-panel-2 px-3 py-1.5"
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              cancelRef.current = true
              setEditing(false)
            }
          }}
          onBlur={commit}
          placeholder={props.item.title}
          className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none"
        />
      </form>
    )
  }

  const kids = props.childCount ?? 0
  const typeLabel = props.item.agentName?.trim()
  // Nested rows read as the subagent type (`general-purpose`), not a second
  // conversation title. A custom rename still wins.
  const showTypePill = props.nested === true && !customName && !!typeLabel
  const visibleLabel = showTypePill ? typeLabel : (customName ?? props.item.title)
  return (
    <div
      className={`group mb-1 flex items-center rounded ${
        props.active ? 'bg-panel-2' : 'hover:bg-panel-2'
      }`}
    >
      {props.onToggleNest && kids > 0 && (
        <button
          type="button"
          onClick={props.onToggleNest}
          aria-expanded={props.expanded === true}
          aria-label={
            props.expanded ? 'collapse nested conversations' : 'expand nested conversations'
          }
          title={props.expanded ? 'collapse nested conversations' : 'expand nested conversations'}
          className="px-1 py-2 font-mono text-[11px] text-ink-dim hover:text-ink"
        >
          {props.expanded ? '▾' : '▸'}
        </button>
      )}
      <button
        type="button"
        onClick={props.onSelect}
        title={
          showTypePill
            ? `${props.item.title} · ${props.item.sessionId ?? props.item.key}`
            : (props.item.sessionId ??
              (props.item.command ? `${props.item.command} · ${props.item.key}` : props.item.key))
        }
        className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs ${
          props.active ? 'text-em' : 'text-ink-dim group-hover:text-ink'
        }`}
      >
        {props.nested && (
          <span className="w-3 shrink-0 text-center font-mono text-[11px] text-ink-dim" aria-hidden>
            └
          </span>
        )}
        {showTypePill && (
          <span className="shrink-0 rounded bg-panel-2 px-1.5 font-mono text-[10px] text-ink">
            {typeLabel}
          </span>
        )}
        {/* same accent as the Agents rail dot (preset hex, else harness).
            On a nested row it sits after the type pill. */}
        {props.tokenAccent ? (
          <span
            className="sc-accent size-1.5 shrink-0 rounded-full"
            data-harness={harnessAccentKey({
              harnessId: props.item.harnessId,
              command: props.item.command,
            })}
            aria-hidden
          />
        ) : (
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{
              background: accentFor({
                presetColor: props.item.accent,
                harnessId: props.item.harnessId,
                command: props.item.command,
              }),
            }}
            aria-hidden
          />
        )}
        {!showTypePill && <span className="min-w-0 truncate">{visibleLabel}</span>}
        {kids > 0 && !props.expanded && (
          <span
            className="shrink-0 font-mono text-[10px] text-ink-dim"
            title="nested conversations"
          >
            {kids}
          </span>
        )}
        {/* live pip: a turn in flight pulses; an alive-but-quiet session is a
            steady dim dot. `status` only exists for control-plane rows. */}
        {props.item.status === 'active' && (
          <span className="relative flex size-1.5 shrink-0" title="turn in flight">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-em opacity-60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-em" />
          </span>
        )}
        {props.item.status === 'idle' && (
          <span className="size-1.5 shrink-0 rounded-full bg-em/40" title="session alive" />
        )}
        {(() => {
          const raw = rowPillText({ model: props.item.model }, undefined, props.item.harnessId)
          // A pin row titled after its harness would read it twice. A nested
          // type pill is not the model, so the model still shows beside it.
          const pill = sameLabel(visibleLabel, raw) ? '' : raw
          const native = shortNativeId(props.item.key)
          const tip = props.item.harnessId
            ? `${props.item.harnessId} ${native}`
            : `${pill} ${native}`
          return pill ? (
            <span
              title={tip}
              className="shrink-0 rounded bg-panel-2 px-1 font-mono text-[9px] text-ink-dim"
            >
              {pill}
            </span>
          ) : null
        })()}
      </button>
      <span className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
        <button
          type="button"
          onClick={() => {
            setDraft(customName ?? props.item.title)
            setEditing(true)
          }}
          aria-label="rename conversation"
          title="rename"
          className="px-1 py-2 text-ink-dim hover:text-em"
        >
          <Pencil className="size-3" />
        </button>
        {props.onDiscard ? (
          <button
            type="button"
            onClick={props.onDiscard}
            aria-label="discard draft"
            title="discard draft"
            className="px-1 py-2 pr-2 text-ink-dim hover:text-red"
          >
            <Trash2 className="size-3" />
          </button>
        ) : props.archived ? (
          <button
            type="button"
            onClick={props.onUnarchive}
            aria-label="unarchive conversation"
            title="unarchive"
            className="px-1 py-2 pr-2 text-ink-dim hover:text-em"
          >
            <ArchiveRestore className="size-3" />
          </button>
        ) : (
          <button
            type="button"
            onClick={props.onArchive}
            aria-label="archive conversation"
            title="archive (hides the row — the session itself is untouched)"
            className="px-1 py-2 pr-2 text-ink-dim hover:text-em"
          >
            <Archive className="size-3" />
          </button>
        )}
      </span>
    </div>
  )
}
