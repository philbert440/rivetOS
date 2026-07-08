import type { JSX } from 'react'
import { Link } from '@tanstack/react-router'
import { useConnection, isValidGatewayUrl } from '../stores/connection.js'
import { DenBot } from './den-bot.js'

/** True when the active endpoint is a usable http(s) gateway. */
export function useGatewayReady(): boolean {
  return useConnection((s) => isValidGatewayUrl(s.baseUrl))
}

/** Shared first-run / unconfigured affordance — every gateway-backed page
 *  shows this instead of error spam when no node is connected (#306). */
export function NotConnected(): JSX.Element {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3">
      <DenBot className="size-16 opacity-90" />
      <div className="text-sm text-ink-dim">No node connected.</div>
      <Link
        to="/settings"
        className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em"
      >
        Connect to a node
      </Link>
    </div>
  )
}
