/**
 * RivetGateway pointed at datahub for Memory wiki reads.
 * Separate from the chat-node connection so node switch never hijacks wiki.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RivetGateway } from '@rivetos/gateway-client'
import { useConnection, tokenFor } from '../stores/connection.js'
import { useWikiSettings } from '../stores/wiki-settings.js'
import { isValidGatewayUrl } from './gateway-url.js'
import { datahubBaseFromMesh } from './wiki-base.js'

export interface WikiEndpoint {
  baseUrl: string
  source: 'settings' | 'mesh'
  gateway: RivetGateway
}

/**
 * Resolve datahub origin: explicit Settings override, else mesh roster
 * entry named datahub (queried through the active chat node).
 */
export function useWikiEndpoint(): {
  endpoint: WikiEndpoint | null
  /** Settings empty and mesh not yet resolved / no datahub row. */
  pending: boolean
  /** Active chat node missing — can't mesh-discover. */
  needNode: boolean
} {
  const settingsBase = useWikiSettings((s) => s.wikiBaseUrl)
  const chatBase = useConnection((s) => s.baseUrl)
  const chatReady = isValidGatewayUrl(chatBase)

  const mesh = useQuery({
    queryKey: ['mesh-for-wiki', chatBase],
    queryFn: ({ signal }) => useConnection.getState().gateway.meshOverview(signal),
    enabled: !settingsBase && chatReady,
    staleTime: 60_000,
  })

  return useMemo(() => {
    if (settingsBase) {
      // Prefer a saved token for that origin (same sessionStorage scheme as
      // the node roster); datahub is usually tokenless.
      const token = tokenFor(settingsBase)
      return {
        endpoint: {
          baseUrl: settingsBase,
          source: 'settings' as const,
          gateway: new RivetGateway({
            baseUrl: settingsBase,
            token,
            authMode: token ? 'bearer' : 'none',
          }),
        },
        pending: false,
        needNode: false,
      }
    }

    if (!chatReady) {
      return { endpoint: null, pending: false, needNode: true }
    }

    if (mesh.isLoading || mesh.isFetching) {
      return { endpoint: null, pending: true, needNode: false }
    }

    const fromMesh = mesh.data ? datahubBaseFromMesh(mesh.data.nodes) : null
    if (fromMesh) {
      const token = tokenFor(fromMesh)
      return {
        endpoint: {
          baseUrl: fromMesh,
          source: 'mesh' as const,
          gateway: new RivetGateway({
            baseUrl: fromMesh,
            token,
            authMode: token ? 'bearer' : 'none',
          }),
        },
        pending: false,
        needNode: false,
      }
    }

    return { endpoint: null, pending: false, needNode: false }
  }, [settingsBase, chatReady, mesh.isLoading, mesh.isFetching, mesh.data])
}
