/**
 * Tag chips — the one way the hub renders `key:value` tags. Accepted chips
 * are solid; suggested chips are dashed with inline accept (✓) / reject (✕)
 * when the caller can decide. Accepted chips offer remove (= reject) on
 * hover when `onReject` is given. `AddTagInline` is the "+ tag" affordance.
 */

import { useState, type JSX } from 'react'
import { Check, Plus, X } from 'lucide-react'
import { chipLabel, tagLabel, type AnyTag, isFilterableChip, isTagLiteral } from '../lib/session-tags.js'
import { cn } from '../lib/utils.js'

export function TagChip(props: {
  tag: AnyTag & { action?: 'add' | 'remove' }
  onAccept?: (id: string) => void
  onReject?: (id: string) => void
  onClick?: (tag: AnyTag) => void
  busy?: boolean
  size?: 'sm' | 'md'
}): JSX.Element {
  const { tag } = props
  const removal = tag.action === 'remove'
  const suggested = tag.state === 'suggested' || removal
  const label = chipLabel(tag)
  const plain = tagLabel(tag)
  const base =
    props.size === 'md'
      ? 'inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[11px]'
      : 'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]'
  const tone = suggested
    ? 'border-dashed border-warn/50 bg-warn/5 text-warn'
    : 'border-em/40 bg-em/10 text-em'
  const title = suggested
    ? `Suggested by ${tag.source}${'reason' in tag && (tag as { reason?: string }).reason ? ` — ${(tag as { reason?: string }).reason ?? ''}` : ''}`
    : `${label} (${tag.source})`
  return (
    <span
      className={cn(base, tone, 'group max-w-full')}
      title={title}
      data-state={tag.state}
      data-action={removal ? 'remove' : 'add'}
    >
      {/* Only an accepted tag is a filter: filters match accepted tags. */}
      {props.onClick && isFilterableChip(tag) ? (
        <button
          type="button"
          className="truncate hover:underline"
          onClick={(e) => {
            e.stopPropagation()
            props.onClick?.(tag)
          }}
        >
          {label}
        </button>
      ) : (
        <span className="truncate">{label}</span>
      )}
      {suggested && props.onAccept && (
        <button
          type="button"
          aria-label={removal ? `remove ${plain}` : `accept ${plain}`}
          title={removal ? 'remove' : 'accept'}
          disabled={props.busy}
          className="rounded p-0.5 hover:bg-em/20 hover:text-em disabled:opacity-50"
          onClick={(e) => {
            e.stopPropagation()
            props.onAccept?.(tag.id)
          }}
        >
          <Check className="size-3" />
        </button>
      )}
      {props.onReject && (
        <button
          type="button"
          aria-label={removal ? `keep ${plain}` : suggested ? `reject ${plain}` : `remove ${plain}`}
          title={removal ? 'keep' : suggested ? 'reject' : 'remove'}
          disabled={props.busy}
          className={cn(
            'rounded p-0.5 hover:bg-red/20 hover:text-red disabled:opacity-50',
            !suggested && 'opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
          onClick={(e) => {
            e.stopPropagation()
            props.onReject?.(tag.id)
          }}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

export function TagChips(props: {
  tags: readonly AnyTag[]
  onAccept?: (id: string) => void
  onReject?: (id: string) => void
  onClick?: (tag: AnyTag) => void
  busy?: boolean
  size?: 'sm' | 'md'
  /** Render at most this many, then "+N". */
  max?: number
  className?: string
}): JSX.Element | null {
  if (props.tags.length === 0) return null
  const shown = props.max ? props.tags.slice(0, props.max) : props.tags
  const rest = props.tags.length - shown.length
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', props.className)}>
      {shown.map((t) => (
        <TagChip
          key={t.id}
          tag={t}
          onAccept={props.onAccept}
          onReject={props.onReject}
          onClick={props.onClick}
          busy={props.busy}
          size={props.size}
        />
      ))}
      {rest > 0 && (
        <span
          className="font-mono text-[10px] text-ink-dim"
          title={props.tags.slice(shown.length).map(tagLabel).join(', ')}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}

/**
 * "+ tag" that expands into a key:value input. Submits on Enter. `onAdd`
 * resolves to false (or rejects) when the tag was not added; the input then
 * stays open with a short message instead of failing silently.
 */
export function AddTagInline(props: {
  onAdd: (literal: string) => boolean | undefined | Promise<boolean | undefined>
  busy?: boolean
  placeholder?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState('')
  if (!open) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded border border-dashed border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-dim hover:border-em hover:text-em"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        title="add a key:value tag"
      >
        <Plus className="size-3" /> tag
      </button>
    )
  }
  const submit = async (): Promise<void> => {
    const literal = value.trim()
    if (!isTagLiteral(literal)) {
      setProblem('use key:value, e.g. project:name')
      return
    }
    let added: boolean | undefined
    try {
      added = await props.onAdd(literal)
    } catch {
      added = false
    }
    if (added === false) {
      setProblem('could not add the tag')
      return
    }
    setProblem('')
    setValue('')
    setOpen(false)
  }
  return (
    <form
      className="inline-flex items-center gap-1"
      onClick={(e) => {
        e.stopPropagation()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <input
        autoFocus
        value={value}
        disabled={props.busy}
        onChange={(e) => {
          setValue(e.target.value)
          setProblem('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setValue('')
            setProblem('')
            setOpen(false)
          }
        }}
        placeholder={props.placeholder ?? 'project:name'}
        aria-label="new tag key:value"
        aria-invalid={problem !== ''}
        className="w-36 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink placeholder:text-ink-dim"
      />
      <button
        type="submit"
        disabled={props.busy || value.trim() === ''}
        className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-dim hover:border-em hover:text-em disabled:opacity-50"
      >
        add
      </button>
      {problem !== '' && (
        <span className="font-mono text-[10px] text-red" role="alert">
          {problem}
        </span>
      )}
    </form>
  )
}
