/**
 * Which node, gate, and control-plane stream a conversation uses.
 *
 * ActiveSession and a space mini must resolve a remote row the same way:
 * summary and registry come from the session's own node, not the drawer's.
 * Local rows keep the gate the caller already computed. The open thread is
 * still the only caller that touches bindings or declares a remote 404.
 */

import { useCallback, useMemo, useRef } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { HarnessSessionResponse, HarnessesResponse } from '@rivetos/types'
import type { RivetGateway } from '@rivetos/gateway-client'
import { gatewayFor } from './agent-gateway.js'
import {
  chatItemFromSummary,
  harnessGate,
  type ChatItem,
  type HarnessGate,
} from './harness-chat.js'
import { sessionNodeFor } from './session-node.js'
import { useConnection } from '../stores/connection.js'

export function useSessionTarget(args: {
  sessionId: string
  item?: ChatItem
  /** Gate against the current node's registry. Remote rows replace this. */
  gate: HarnessGate
  harnessCommand?: string
  baseUrl: string
  rosterUrls: readonly string[]
  /** Bumps when the gateway client is replaced without a baseUrl change. */
  epoch: number
}): {
  sessionBase: string
  isRemote: boolean
  sessionGateway: () => Promise<RivetGateway>
  remoteSummary: UseQueryResult<HarnessSessionResponse>
  remoteRegistry: UseQueryResult<HarnessesResponse>
  item: ChatItem | undefined
  gate: HarnessGate
  harnessCommand: string | undefined
  canonicalId: string | undefined
  streamId: string | undefined
} {
  // FROZEN per mount: every call site below must agree on home-vs-remote for
  // the life of this view, so re-resolution may only move the base to a
  // DIFFERENT roster-valid node (a pointer legitimately retargeted). A
  // resolution that falls back to the current node — roster drop, binding
  // eviction, a global node switch under an open thread — is rejected: the
  // thread keeps the node it was opened against rather than silently
  // retargeting attach/inject/uploads at whatever the app is pointed at.
  const frozenBaseRef = useRef<string | undefined>(undefined)
  const sessionBase = useMemo(() => {
    const resolved = sessionNodeFor(args.sessionId, args.baseUrl, args.rosterUrls)
    const prev = frozenBaseRef.current
    const next =
      prev === undefined || (resolved !== prev && resolved !== args.baseUrl) ? resolved : prev
    frozenBaseRef.current = next
    return next
  }, [args.sessionId, args.baseUrl, args.rosterUrls])
  const isRemote = sessionBase !== args.baseUrl
  // The session's gateway: the shared global client on the home path (it
  // carries the live transport state), a pipe-routed per-node client when
  // the thread lives elsewhere. Callers re-acquire per call, so an epoch
  // bump mid-session is picked up by the next operation.
  const sessionGateway = useCallback(
    () => (isRemote ? gatewayFor(sessionBase) : Promise.resolve(useConnection.getState().gateway)),
    // epoch: gatewayFor consults the pipe map, which the epoch invalidates.
    [isRemote, sessionBase, args.epoch],
  )

  // Cross-node rows have no local drawer entry: fetch the summary and the
  // registry sheet from the session's node and synthesize what the drawer
  // would have provided. A 404 here means the thread is gone — the gate
  // stays closed and the transcript backfill renders what history remains.
  const remoteSummary = useQuery({
    queryKey: ['remote-session', sessionBase, args.sessionId, args.epoch],
    queryFn: async ({ signal }) =>
      (await gatewayFor(sessionBase)).getHarnessSession(args.sessionId, signal),
    enabled: isRemote,
    retry: 1,
  })
  const registryQueryKey = isRemote
    ? (['harnesses', sessionBase, args.epoch] as const)
    : (['harnesses', sessionBase] as const)
  const remoteRegistry = useQuery({
    queryKey: registryQueryKey,
    queryFn: ({ signal }) => gatewayFor(sessionBase).then((gw) => gw.harnesses(signal)),
    staleTime: 300_000,
  })
  const remoteItem = useMemo(
    () => (isRemote && remoteSummary.data ? chatItemFromSummary(remoteSummary.data) : undefined),
    [isRemote, remoteSummary.data],
  )
  const item = isRemote ? remoteItem : args.item
  const gate = isRemote ? harnessGate(remoteItem, remoteRegistry.data?.harnesses) : args.gate
  const harnessCommand = isRemote ? remoteItem?.command : args.harnessCommand
  const canonicalId = gate.bound ? item?.sessionId : undefined
  const streamId = gate.stream ? canonicalId : undefined

  return {
    sessionBase,
    isRemote,
    sessionGateway,
    remoteSummary,
    remoteRegistry,
    item,
    gate,
    harnessCommand,
    canonicalId,
    streamId,
  }
}
