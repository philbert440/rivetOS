import { queryOptions, useQuery } from '@tanstack/react-query'
import { transportBase } from './mtls-proxy.js'

/** `/healthz` identity. `hostname` is `name`; `node` is the mesh node name. */
export type HealthzProbe = { hostname: string | null; node: string | null }

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Roster probe. `node` is the mesh name (`/healthz.node` since slice 2) and
 * is what agent resolution matches — `name` stays the hostname label.
 */
export async function fetchHealthz(baseUrl: string, signal?: AbortSignal): Promise<HealthzProbe> {
  // Desktop mTLS (#491): https gateways are reached via the shell's loopback
  // identity pipe; everywhere else this resolves to baseUrl.
  const base = await transportBase(baseUrl.replace(/\/+$/, ''))
  const res = await fetch(`${base.replace(/\/+$/, '')}/healthz`, { signal })
  if (!res.ok) return { hostname: null, node: null }
  const body = (await res.json()) as { name?: unknown; node?: unknown }
  return { hostname: nonEmpty(body.name), node: nonEmpty(body.node) }
}

export function healthzQueryOptions(baseUrl: string) {
  return queryOptions({
    queryKey: ['node-name', baseUrl] as const,
    enabled: /^https?:\/\//.test(baseUrl),
    staleTime: 3_600_000,
    gcTime: 3_600_000,
    retry: false,
    queryFn: ({ signal }) => fetchHealthz(baseUrl, signal),
  })
}

/** Prettify a node hostname into a human label: `rivet-grok` → `Rivet-Grok`,
 *  `rivet-cfo` → `Rivet-Cfo`. Splits on hyphens/dots, title-cases each part. */
export function prettifyNodeName(host: string): string {
  return host
    .split(/[-.]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('-')
}

/** Strip the scheme (and trailing slash) from a gateway URL → `host:port`. The
 *  last-resort label when a node's hostname isn't available. */
export function urlLabel(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/**
 * A node's human-readable name from its `/healthz` (which reports the node's
 * hostname as `name`). Cached long — a node's hostname doesn't change within a
 * session. Returns undefined until resolved / when the node is old (no `name`
 * field yet) / on error — callers fall back to the roster name, then urlLabel.
 * The same probe records `node` (the mesh name) for `useMeshNodeName`.
 */
export function useNodeName(baseUrl: string): string | undefined {
  const hostname = useQuery(healthzQueryOptions(baseUrl)).data?.hostname
  return hostname ? prettifyNodeName(hostname) : undefined
}

/** Mesh node name from the same `/healthz` probe (`node`, not the hostname). */
export function useMeshNodeName(baseUrl: string): string | undefined {
  return useQuery(healthzQueryOptions(baseUrl)).data?.node || undefined
}
