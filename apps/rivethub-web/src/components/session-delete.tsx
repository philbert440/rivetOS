/**
 * Delete flow shared by the drawer row action, multi-select and the clean-up
 * review: one confirm that names what goes, then the wire call, then the
 * local sweep so nothing resurrects. Nothing is sent before the confirm
 * resolves true, and a live session (409) is reported, never killed.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HarnessSessionsResponse, HarnessSessionSummary } from '@rivetos/types'
import { useConfirmDialog } from './confirm-dialog.js'
import { forgetDeletedSession } from '../lib/discard-session.js'
import { denRoomKey } from '../lib/harness-chat.js'
import {
  DELETE_BATCH_MAX,
  deleteConfirmMessage,
  failureFromError,
  foldDeleteResults,
  outcomeNotice,
  type DeleteOutcome,
} from '../lib/session-delete.js'
import { useConnection } from '../stores/connection.js'

export interface DeleteTarget {
  /** Canonical `<harness-id>:<native>` id the gateway deletes. */
  session: string
  /** What the user sees for the row (custom name over title). */
  label: string
}

const NOTICE_MS = 8_000

export function useSessionDelete(): {
  /** Confirm, delete, sweep. Resolves undefined when the user cancelled. */
  requestDelete: (targets: readonly DeleteTarget[]) => Promise<DeleteOutcome | undefined>
  /** Last outcome, one line; cleared after a few seconds or on dismiss. */
  notice: string | undefined
  dismissNotice: () => void
  /** Render once — the confirm dialog. */
  element: JSX.Element
} {
  const dialog = useConfirmDialog()
  const queryClient = useQueryClient()
  const [notice, setNotice] = useState<string | undefined>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current)
    },
    [],
  )

  const show = useCallback((text: string): void => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    setNotice(text || undefined)
    timer.current = setTimeout(() => {
      timer.current = undefined
      setNotice(undefined)
    }, NOTICE_MS)
  }, [])

  const dismissNotice = useCallback((): void => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    setNotice(undefined)
  }, [])

  const { confirm } = dialog
  const requestDelete = useCallback(
    async (targets: readonly DeleteTarget[]): Promise<DeleteOutcome | undefined> => {
      const unique = [...new Map(targets.map((t) => [t.session, t] as const)).values()]
      if (unique.length === 0) return undefined
      const ok = await confirm(deleteConfirmMessage(unique.map((t) => t.label)), {
        confirmLabel: unique.length === 1 ? 'Delete' : `Delete ${unique.length}`,
        danger: true,
      })
      if (!ok) return undefined

      // The deletes go to the node the drawer is connected to; read it after
      // the confirm so a node switch mid-dialog cannot retarget the request.
      const { baseUrl, gateway } = useConnection.getState()
      const ids = unique.map((t) => t.session)
      let outcome: DeleteOutcome
      if (ids.length === 1) {
        try {
          await gateway.deleteSession(ids[0] ?? '')
          outcome = { deleted: ids, failed: [] }
        } catch (err) {
          const f = failureFromError(err)
          outcome = { deleted: [], failed: [{ session: ids[0] ?? '', ...f }] }
        }
      } else {
        outcome = { deleted: [], failed: [] }
        for (let i = 0; i < ids.length; i += DELETE_BATCH_MAX) {
          const chunk = ids.slice(i, i + DELETE_BATCH_MAX)
          try {
            const res = await gateway.deleteSessions(chunk)
            const part = foldDeleteResults(chunk, res.results)
            outcome.deleted.push(...part.deleted)
            outcome.failed.push(...part.failed)
          } catch (err) {
            const f = failureFromError(err)
            outcome.failed.push(...chunk.map((session) => ({ session, ...f })))
          }
        }
      }

      // Only what the node confirmed gone is swept locally. A failure keeps
      // the row and every trace (name, settings, archive flag) intact.
      if (outcome.deleted.length > 0) {
        const gone = new Set(outcome.deleted)
        const goneNative = new Set(outcome.deleted.map(denRoomKey))
        for (const id of outcome.deleted) forgetDeletedSession(baseUrl, id)
        queryClient.setQueriesData<HarnessSessionSummary[]>(
          { queryKey: ['harness-plane-sessions', baseUrl] },
          (prev) => prev?.filter((s) => !gone.has(s.sessionId)),
        )
        queryClient.setQueriesData<HarnessSessionsResponse>(
          { queryKey: ['harness-sessions', baseUrl] },
          (prev) =>
            prev && { ...prev, sessions: prev.sessions.filter((s) => !goneNative.has(s.id)) },
        )
        void queryClient.invalidateQueries({ queryKey: ['harness-plane-sessions', baseUrl] })
        void queryClient.invalidateQueries({ queryKey: ['harness-sessions', baseUrl] })
      }
      void queryClient.invalidateQueries({ queryKey: ['session-trash', baseUrl] })

      const labels = new Map(unique.map((t) => [t.session, t.label] as const))
      show(outcomeNotice(outcome, (id) => labels.get(id) ?? id))
      return outcome
    },
    [confirm, queryClient, show],
  )

  return { requestDelete, notice, dismissNotice, element: dialog.element }
}

/** The drawer's transient result line (the app's toasts are for push frames). */
export function DeleteNotice(props: {
  notice: string | undefined
  onDismiss: () => void
}): JSX.Element | null {
  if (!props.notice) return null
  return (
    <div
      role="status"
      className="mx-2 mb-2 flex items-start gap-2 rounded-xl bg-panel-2 px-3 py-2 text-xs text-ink classic:mx-0 classic:rounded-none classic:border-line classic:border-t classic:text-[11px]"
    >
      <span className="min-w-0 flex-1">{props.notice}</span>
      <button
        type="button"
        onClick={props.onDismiss}
        aria-label="dismiss"
        className="shrink-0 text-ink-dim hover:text-ink"
      >
        ✕
      </button>
    </div>
  )
}
