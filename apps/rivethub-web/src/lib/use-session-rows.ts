/**
 * Session index rows for the connected node — the union of control-plane and
 * legacy sessions through the same `chatItems` / `fetchHarnessPlaneSessions`
 * merge Chat uses. Shared by the Sessions page and the Memory home so neither
 * forks the merge or its live reconciliation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { HarnessSessionSummary } from '@rivetos/types'
import { useGatewayReady } from '../components/not-connected.js'
import {
  applyRegistryEventToPlaneSessions,
  chatItems,
  fetchHarnessPlaneSessions,
} from './harness-chat.js'
import { sessionListRows, type SessionListRow } from './session-list.js'
import { useStatusBlocks, withStatusBlocks } from './status-blocks.js'
import { useConnection } from '../stores/connection.js'

export interface SessionRows {
  connected: boolean
  rows: SessionListRow[]
  /** Message from the plane or legacy list fetch, when either failed. */
  loadError: string | null
  /** When the registry stream reopened and the list was refetched. */
  listResyncedAt: number | undefined
}

export function useSessionRows(): SessionRows {
  const baseUrl = useConnection((s) => s.baseUrl)
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const connected = useGatewayReady()
  const queryClient = useQueryClient()
  const [listResyncedAt, setListResyncedAt] = useState<number | undefined>()

  const registryQuery = useQuery({
    queryKey: ['harnesses', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.harnesses(signal),
    staleTime: 300_000,
    enabled: connected,
  })
  const descriptors = registryQuery.data?.harnesses

  const planeQueryKey = ['harness-plane-sessions', baseUrl, descriptors?.length ?? 0] as const
  const planeQuery = useQuery({
    queryKey: planeQueryKey,
    queryFn: ({ signal }) =>
      fetchHarnessPlaneSessions(useConnection.getState().gateway, descriptors, signal),
    enabled: connected && (descriptors?.length ?? 0) > 0,
  })

  const legacyQuery = useQuery({
    queryKey: ['harness-sessions', baseUrl],
    queryFn: ({ signal }) => useConnection.getState().gateway.harnessSessions(signal),
    enabled: connected,
  })

  // Same reconciliation refetch as the chat drawer. Debounced: the list walks
  // every harness store synchronously on the den loop that echoes PTY bytes.
  // A stream reopen still refetches immediately (no replay).
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const invalidateSessionsNow = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['harness-sessions', baseUrl] })
    void queryClient.invalidateQueries({ queryKey: ['harness-plane-sessions', baseUrl] })
  }, [queryClient, baseUrl])
  const invalidateSessions = useCallback((): void => {
    if (invalidateTimer.current !== undefined) return
    invalidateTimer.current = setTimeout(() => {
      invalidateTimer.current = undefined
      invalidateSessionsNow()
    }, 1_000)
  }, [invalidateSessionsNow])
  useEffect(() => {
    return () => {
      if (invalidateTimer.current !== undefined) {
        clearTimeout(invalidateTimer.current)
        invalidateTimer.current = undefined
      }
    }
  }, [baseUrl])

  // ACP drivers report a permission wait only as a registry `status` frame.
  const statusBlocks = useStatusBlocks()
  const { observe: observeStatus, reset: resetStatusBlocks } = statusBlocks

  const hasDrivers = (descriptors?.length ?? 0) > 0
  useEffect(() => {
    if (!connected || !hasDrivers) return
    let opens = 0
    const sub = useConnection.getState().gateway.watchHarnesses(
      (event) => {
        observeStatus(event)
        if (event.type !== 'session-created' && event.type !== 'session-updated') return
        queryClient.setQueryData<HarnessSessionSummary[]>(planeQueryKey, (prev) =>
          applyRegistryEventToPlaneSessions(prev, event),
        )
        invalidateSessions()
      },
      undefined,
      {
        onStatus: (status) => {
          if (status !== 'open') return
          opens += 1
          // Registry stream has no replay — refetch on every reopen.
          // Status frames are not replayed either: drop stale blocks.
          if (opens > 1) {
            resetStatusBlocks()
            invalidateSessionsNow()
            setListResyncedAt(Date.now())
          }
        },
      },
    )
    return () => {
      sub.close()
      resetStatusBlocks()
    }
  }, [
    connected,
    hasDrivers,
    baseUrl,
    transportEpoch,
    queryClient,
    descriptors?.length,
    invalidateSessions,
    invalidateSessionsNow,
    observeStatus,
    resetStatusBlocks,
  ])

  const items = useMemo(
    () =>
      chatItems({
        drafts: [],
        harnessSessions: planeQuery.data ?? [],
        legacySessions: legacyQuery.data?.sessions ?? [],
      }),
    [planeQuery.data, legacyQuery.data?.sessions],
  )

  const rows = useMemo(
    () => sessionListRows(items, withStatusBlocks(planeQuery.data, statusBlocks.blocks) ?? []),
    [items, planeQuery.data, statusBlocks.version],
  )

  const loadError =
    planeQuery.isError || legacyQuery.isError
      ? (planeQuery.error?.message ?? legacyQuery.error?.message ?? 'failed to load sessions')
      : null

  return { connected, rows, loadError, listResyncedAt }
}
