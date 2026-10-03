/**
 * Session tag hooks — one lookup query per session-key set and one mutation
 * set (decide / add) that invalidates every tag query on the same datahub.
 * Sessions index, session detail and the memory views all go through here
 * so a decision in one place shows up in the others on the next render.
 */

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RivetGateway } from '@rivetos/gateway-client'
import { useWikiEndpoint } from './wiki-client.js'
import { chunkKeys, mergeLookups, tagsBySession, type AnyTag } from './session-tags.js'

export interface TagEndpoint {
  gateway: RivetGateway
  baseUrl: string
}

/** The datahub endpoint tags live on (same resolution as wiki/search). */
export function useTagEndpoint(): TagEndpoint | null {
  const { endpoint } = useWikiEndpoint()
  return endpoint ? { gateway: endpoint.gateway, baseUrl: endpoint.baseUrl } : null
}

export const TAG_QUERY_ROOT = 'memory-tags'

/**
 * Tags (accepted + suggested) for a set of session keys. Empty map without
 * datahub and on first load; when only the session set changes, the previous
 * tags stand in (with `isLoading` true) until the new lookup answers; `error` is set when the lookup failed so the
 * caller can say so instead of showing an untagged list as if it were true.
 */
export function useSessionTagsLookup(
  endpoint: TagEndpoint | null,
  sessionKeys: readonly string[],
): { map: Map<string, AnyTag[]>; isLoading: boolean; error: Error | null } {
  const keys = [...sessionKeys].sort()
  const baseUrl = endpoint?.baseUrl
  const query = useQuery<Record<string, AnyTag[]>>({
    queryKey: [TAG_QUERY_ROOT, baseUrl, 'lookup', keys],
    enabled: Boolean(endpoint) && keys.length > 0,
    staleTime: 15_000,
    retry: false,
    // The key embeds the session set, so a new session is a new query: keep
    // showing the previous tags until the new lookup answers.
    // Only across a change of the session set on the same datahub — never
    // across an endpoint change, and never once the endpoint is gone.
    placeholderData: (prev, prevQuery) =>
      baseUrl !== undefined && prevQuery?.queryKey[1] === baseUrl ? prev : undefined,
    queryFn: async ({ signal }) => {
      if (!endpoint) return {}
      // Every key is looked up: past the per-request cap the list is chunked,
      // never silently truncated.
      const parts = await Promise.all(
        chunkKeys(keys).map((chunk) =>
          endpoint.gateway.memoryTagsLookup({ session_keys: chunk }, signal),
        ),
      )
      return mergeLookups(parts)
    },
  })
  // Stable identity while the data is unchanged, so dependants can memoize on it.
  const map = useMemo(() => tagsBySession(query.data), [query.data])
  return {
    map,
    // Also true while the previous set's tags stand in during a refetch.
    isLoading: query.isLoading || (query.isPlaceholderData && query.isFetching),
    error: query.error,
  }
}

/**
 * decide / add mutations. Every tag query on this datahub refetches
 * afterwards. Both calls resolve to `true` on success and `false` on failure
 * (never reject), with the failure kept in `error` for the caller to render,
 * so a chip's click handler can fire them without its own catch.
 */
export function useTagMutations(endpoint: TagEndpoint | null): {
  decide: (ids: string[], state: 'accepted' | 'rejected') => Promise<boolean>
  /** Tag the conversation captured under a session key (born accepted). */
  addToSession: (sessionKey: string, literal: string) => Promise<boolean>
  busy: boolean
  error: Error | null
} {
  const queryClient = useQueryClient()
  const invalidate = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: [TAG_QUERY_ROOT, endpoint?.baseUrl] })

  const decide = useMutation({
    mutationFn: async (input: { ids: string[]; state: 'accepted' | 'rejected' }) => {
      if (!endpoint) throw new Error('datahub not configured')
      await endpoint.gateway.memoryTagsDecide(input)
    },
    onSettled: () => void invalidate(),
  })
  const add = useMutation({
    mutationFn: async (input: { sessionKey: string; literal: string }) => {
      if (!endpoint) throw new Error('datahub not configured')
      await endpoint.gateway.memoryTagsAdd({
        entity_type: 'conversation',
        session_key: input.sessionKey,
        tag: input.literal,
      })
    },
    onSettled: () => void invalidate(),
  })

  const settled = (p: Promise<unknown>): Promise<boolean> =>
    p.then(
      () => true,
      () => false,
    )
  return {
    decide: (ids, state) => settled(decide.mutateAsync({ ids, state })),
    addToSession: (sessionKey, literal) => settled(add.mutateAsync({ sessionKey, literal })),
    busy: decide.isPending || add.isPending,
    // The error of whichever mutation ran last, so a later success clears an
    // earlier failure instead of leaving a stale message up.
    error: (add.submittedAt > decide.submittedAt ? add.error : decide.error) ?? null,
  }
}
