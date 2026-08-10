/**
 * RivetGateway pointed at datahub for Memory wiki reads.
 * Separate from the chat-node connection so node switch never hijacks wiki.
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RivetGateway } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { useWikiSettings } from '../stores/wiki-settings.js'
import { isValidGatewayUrl } from './gateway-url.js'
import { datahubBaseFromMesh } from './wiki-base.js'
import { transportBase } from './mtls-proxy.js'

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

  // The wiki base's IDENTITY (what the UI shows / keys on), before transport.
  const picked = useMemo((): { baseUrl: string; source: 'settings' | 'mesh' } | null => {
    if (settingsBase) return { baseUrl: settingsBase, source: 'settings' }
    if (!chatReady) return null
    const fromMesh = mesh.data ? datahubBaseFromMesh(mesh.data.nodes) : null
    return fromMesh ? { baseUrl: fromMesh, source: 'mesh' } : null
  }, [settingsBase, chatReady, mesh.data])

  // Desktop mTLS (#491): an https datahub must ride the shell's loopback
  // identity pipe like every other gateway — a fourth RivetGateway
  // construction dialing WebKitGTK directly would silently fail its mTLS.
  // Browsers / http bases resolve to the base itself instantly.
  const transport = useQuery({
    queryKey: ['wiki-transport', picked?.baseUrl ?? ''],
    enabled: picked !== null,
    staleTime: Infinity,
    queryFn: () => transportBase(picked?.baseUrl ?? ''),
  })

  return useMemo(() => {
    if (!picked) {
      if (!settingsBase && !chatReady) return { endpoint: null, pending: false, needNode: true }
      if (mesh.isLoading || mesh.isFetching) return { endpoint: null, pending: true, needNode: false }
      return { endpoint: null, pending: false, needNode: false }
    }
    if (!transport.data) {
      // resolving the pipe (a frame or two inside Tauri; instant elsewhere)
      return { endpoint: null, pending: true, needNode: false }
    }
    return {
      endpoint: {
        baseUrl: picked.baseUrl,
        source: picked.source,
        gateway: new RivetGateway({ baseUrl: transport.data, authMode: 'mtls' }),
      },
      pending: false,
      needNode: false,
    }
  }, [picked, transport.data, settingsBase, chatReady, mesh.isLoading, mesh.isFetching])
}
