/**
 * The agents rail's roster query. One `agents-all-nodes` subscription —
 * the sidebar and the new-thread dialog both call this hook.
 */

import { useQueries, useQuery } from '@tanstack/react-query'
import { migrateAgentPreset } from '@rivetos/types'
import { gatewayFor } from './agent-gateway.js'
import {
  dedupeRosterAgents,
  uniqueRosterNodes,
  type ListedAgents,
  type NodeChoice,
  type ResolvedRosterAgent,
} from './agent-roster.js'
import { sortRosterAgents } from './agent-order.js'
import { healthzQueryOptions } from './node-name.js'
import { useNodeDiscovery } from './use-node-discovery.js'
import { useConnection } from '../stores/connection.js'

type NodeListMeta = {
  node?: string
  directoryRoot?: string
  sharedDir?: string
  backend?: 'postgres' | 'file'
}

const nodeListMeta = new Map<string, NodeListMeta>()
const lastGoodSliceByNode = new Map<string, ListedAgents & NodeListMeta>()

/** Directory root the last successful agents list reported for this den. */
export function listedNodeDirectory(baseUrl: string): string | undefined {
  return nodeListMeta.get(baseUrl)?.directoryRoot
}

/** Deduped roster, same query the agents rail owns. */
export function useRosterAgents(): { agents: ResolvedRosterAgent[]; isLoading: boolean } {
  const { baseUrl, roster, transportEpoch } = useConnection()
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

  const agents = sortRosterAgents(
    dedupeRosterAgents(nodeQueries.data ?? [], {
      currentBaseUrl: baseUrl,
      mesh: meshNodes,
      roster: rosterForResolve,
    }),
  )
  return { agents, isLoading: nodeQueries.isLoading }
}
