import { useQuery } from '@tanstack/react-query'

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
 */
export function useNodeName(baseUrl: string): string | undefined {
  const q = useQuery({
    queryKey: ['node-name', baseUrl],
    enabled: /^https?:\/\//.test(baseUrl),
    staleTime: 3_600_000,
    gcTime: 3_600_000,
    retry: false,
    queryFn: async ({ signal }): Promise<string | null> => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/healthz`, { signal })
      if (!res.ok) return null
      const body = (await res.json()) as { name?: unknown }
      return typeof body.name === 'string' && body.name ? prettifyNodeName(body.name) : null
    },
  })
  return q.data ?? undefined
}
