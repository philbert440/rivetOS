/**
 * Clean-up review: the sessions the node flags as junk (GET
 * /api/sessions/trash — empty, or a single one-word reply, idle over an
 * hour), for the user to pick from. Nothing is preselected and nothing is
 * deleted until "Delete selected" is confirmed. Rows the user renamed and the
 * open conversation are never offered. An older gateway without the endpoint
 * gets a plain "not supported" line instead of an error.
 */

import { useEffect, useMemo, useState, type JSX } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import type { SessionTrashCandidate } from '@rivetos/types'
import { persisted } from './drawer-item.js'
import { useSessionDelete, DeleteNotice } from './session-delete.js'
import {
  ageLabel,
  failureText,
  isTrashResponse,
  reviewableCandidates,
  trashReasonLabel,
  trashUnsupported,
  type DeleteFailure,
} from '../lib/session-delete.js'
import { useConnection } from '../stores/connection.js'
import { useSessionNames } from '../stores/session-names.js'

/** Gateways that answered the trash read with 404/405/501 this page load. */
const unsupportedBases = new Set<string>()

export function cleanupSupported(baseUrl: string): boolean {
  return !unsupportedBases.has(baseUrl)
}

class TrashUnsupported extends Error {}

export function SessionCleanupSheet(props: {
  open: boolean
  onClose: () => void
  /** The open conversation's key — never offered, whatever the node says. */
  active?: string
  /** The gateway has no trash endpoint; the drawer hides its entry. */
  onUnsupported?: () => void
}): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const names = useSessionNames((s) => s.byKey)
  const del = useSessionDelete()
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [failed, setFailed] = useState<
    ReadonlyMap<string, { kind: DeleteFailure; message: string }>
  >(() => new Map())
  const [busy, setBusy] = useState(false)
  // Deleted this sheet session; hidden before the trash refetch lands.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set())

  const query = useQuery({
    queryKey: ['session-trash', baseUrl],
    queryFn: async ({ signal }) => {
      try {
        const res: unknown = await useConnection.getState().gateway.trashSessions(signal)
        if (!isTrashResponse(res)) throw new TrashUnsupported('not supported')
        return res.candidates
      } catch (err) {
        if (trashUnsupported(err)) throw new TrashUnsupported('not supported')
        throw err
      }
    },
    enabled: props.open,
    retry: false,
    staleTime: 0,
  })
  const unsupported = query.error instanceof TrashUnsupported

  const candidates = useMemo(
    () =>
      reviewableCandidates(
        query.data ?? [],
        (session) => (persisted(names, baseUrl, session) ?? '') !== '',
        new Set([...gone, ...(props.active ? [props.active] : [])]),
      ),
    [query.data, names, baseUrl, props.active, gone],
  )
  const shownIds = new Set(candidates.map((c) => c.session))
  const selected = [...picked].filter((id) => shownIds.has(id))
  const allPicked = candidates.length > 0 && selected.length === candidates.length

  const toggle = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const labelOf = (c: SessionTrashCandidate): string => c.title?.trim() || 'untitled session'

  const deleteSelected = async (): Promise<void> => {
    const targets = candidates
      .filter((c) => picked.has(c.session))
      .map((c) => ({ session: c.session, label: labelOf(c) }))
    setBusy(true)
    try {
      const outcome = await del.requestDelete(targets)
      if (!outcome) return
      setGone((prev) => new Set([...prev, ...outcome.deleted]))
      setPicked((prev) => {
        const next = new Set(prev)
        for (const id of outcome.deleted) next.delete(id)
        return next
      })
      setFailed((prev) => {
        const next = new Map(prev)
        for (const id of outcome.deleted) next.delete(id)
        for (const f of outcome.failed) next.set(f.session, f)
        return next
      })
    } finally {
      setBusy(false)
    }
  }

  const { onUnsupported } = props
  useEffect(() => {
    if (!unsupported) return
    unsupportedBases.add(baseUrl)
    onUnsupported?.()
  }, [unsupported, baseUrl, onUnsupported])

  let body: JSX.Element
  if (query.isPending && props.open) {
    body = <p className="text-xs text-ink-dim">Looking for sessions to clean up…</p>
  } else if (unsupported) {
    body = <p className="text-xs text-ink-dim">Clean up is not supported by this gateway.</p>
  } else if (query.isError) {
    body = (
      <p role="alert" className="text-xs text-red">
        Could not load clean-up candidates: {query.error.message}
      </p>
    )
  } else if (candidates.length === 0) {
    body = <p className="text-xs text-ink-dim">Nothing to clean up.</p>
  } else {
    body = (
      <ul
        className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto"
        aria-label="clean-up candidates"
      >
        {candidates.map((c) => {
          const checked = picked.has(c.session)
          const fail = failed.get(c.session)
          return (
            <li key={c.session}>
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                data-session={c.session}
                onClick={() => toggle(c.session)}
                className="flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-ink/6 classic:hover:bg-panel-2"
              >
                <span
                  aria-hidden
                  className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border text-[10px] leading-none ${
                    checked ? 'border-red bg-red/15 text-red' : 'border-line'
                  }`}
                >
                  {checked ? '✓' : ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-[13px] text-ink classic:text-xs">
                      {labelOf(c)}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-dim classic:text-[10px]">
                      {c.harness} · {ageLabel(c.updatedAt)} · {trashReasonLabel(c.reason)}
                    </span>
                  </span>
                  {c.reply && (
                    <span className="block truncate text-[11px] text-ink-dim classic:text-[10px]">
                      reply: “{c.reply}”
                    </span>
                  )}
                  {fail && (
                    <span className="block text-[11px] text-red classic:text-[10px]">
                      {failureText(fail.kind, fail.message)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    )
  }

  const ready = !unsupported && !query.isError && candidates.length > 0
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 classic:bg-bg/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-40 flex w-[30rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-3xl bg-surface p-6 shadow-pop outline-none classic:bg-panel classic:border classic:border-line classic:p-4">
          <Dialog.Title className="text-sm font-semibold text-ink">Clean up sessions</Dialog.Title>
          <Dialog.Description className="text-xs leading-relaxed text-ink-dim">
            These look like leftovers: no messages at all, or a single one-word reply, untouched for
            over an hour. Nothing is deleted until you pick sessions and confirm. Deleting removes
            their memory and drops them from the list; each harness&apos;s transcript on disk is
            kept.
          </Dialog.Description>
          {body}
          {props.open && <DeleteNotice notice={del.notice} onDismiss={del.dismissNotice} />}
          <div className="flex items-center justify-end gap-2">
            {ready && (
              <button
                type="button"
                onClick={() =>
                  setPicked(allPicked ? new Set() : new Set(candidates.map((c) => c.session)))
                }
                className="mr-auto text-xs text-ink-dim hover:text-ink"
              >
                {allPicked ? 'Select none' : 'Select all'}
              </button>
            )}
            <button
              type="button"
              onClick={props.onClose}
              className="rounded-pill border border-line px-3 py-1.5 text-xs text-ink-dim hover:text-ink hover:bg-ink/6 classic:hover:bg-transparent"
            >
              Close
            </button>
            {ready && (
              <button
                type="button"
                disabled={selected.length === 0 || busy}
                onClick={() => void deleteSelected()}
                className="rounded-pill border border-red/40 px-3 py-1.5 text-xs text-red hover:bg-red/10 disabled:opacity-40 disabled:hover:bg-transparent classic:hover:bg-transparent classic:hover:border-red"
              >
                {selected.length > 0 ? `Delete selected (${selected.length})` : 'Delete selected'}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      {del.element}
    </Dialog.Root>
  )
}
