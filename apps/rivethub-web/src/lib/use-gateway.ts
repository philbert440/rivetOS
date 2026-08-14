/**
 * The active node's gateway client, as a hook.
 *
 * Components that only need the gateway inside handlers/effects have
 * historically grabbed `useConnection.getState().gateway` ad hoc (~40 call
 * sites). This hook is the seam new code should use instead: subscribing to
 * the gateway field means the desktop mTLS swap (#491 — gateway replaced
 * with baseUrl unchanged) re-renders consumers onto the pipe client, where a
 * one-shot getState() snapshot would keep dialing the dead direct gateway.
 */

import type { RivetGateway } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'

export function useGateway(): RivetGateway {
  return useConnection((s) => s.gateway)
}
