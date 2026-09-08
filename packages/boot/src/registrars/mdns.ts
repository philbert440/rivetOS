/**
 * LAN mDNS advertiser — publishes `_rivethub._tcp` after the embedded den
 * gateway is listening so phones/desktops on the LAN can find this node.
 *
 * Gated on `den.advertise_mdns === true`. `bonjour-service` is loaded with
 * dynamic `import()` (boot compiles to CJS). A missing package warns and
 * does not fail boot — advertising is optional.
 */

import { hostname } from 'node:os'
import { logger, type Runtime } from '@rivetos/core'
import type { RivetConfig } from '../config.js'

const log = logger('Boot:Mdns')

const MDNS_TYPE = 'rivethub'
const MDNS_TXT_VERSION = '1'

/** bonjour-service instance surface we actually use. */
interface BonjourHandle {
  publish(opts: { name: string; type: string; port: number; txt?: Record<string, string> }): unknown
  unpublishAll(callback?: () => void): void
  destroy(): void
}

export type MdnsBonjourLoader = () => Promise<unknown>

async function defaultLoadBonjour(): Promise<unknown> {
  return import('bonjour-service')
}

function resolveBonjourCtor(mod: unknown): new () => BonjourHandle {
  const candidates: unknown[] = [mod]
  if (mod && typeof mod === 'object') {
    const rec = mod as { default?: unknown; Bonjour?: unknown }
    candidates.push(rec.Bonjour, rec.default)
    if (rec.default && typeof rec.default === 'object') {
      const nested = rec.default as { default?: unknown; Bonjour?: unknown }
      candidates.push(nested.Bonjour, nested.default)
    }
  }
  for (const cand of candidates) {
    if (typeof cand === 'function') return cand as new () => BonjourHandle
  }
  throw new Error('bonjour-service export is not a constructor')
}

/**
 * Publish this node's den on mDNS when `config.den.advertise_mdns` is true.
 * `denPort` / `tlsConfigured` come from the successful `registerGateway` result.
 *
 * `loadBonjour` is a test seam (defaults to `import('bonjour-service')`).
 */
export async function registerMdnsAdvertiser(
  runtime: Pick<Runtime, 'addShutdownHook'>,
  config: RivetConfig,
  denPort: number,
  tlsConfigured: boolean,
  loadBonjour: MdnsBonjourLoader = defaultLoadBonjour,
): Promise<void> {
  if (config.den?.advertise_mdns !== true) return

  let mod: unknown
  try {
    mod = await loadBonjour()
  } catch (err) {
    log.warn(
      'den.advertise_mdns needs bonjour-service (dependency of @rivetos/boot) — install it: ' +
        (err instanceof Error ? err.message : String(err)),
    )
    return
  }

  const name = hostname()
  const txt = { tls: tlsConfigured ? '1' : '0', v: MDNS_TXT_VERSION }

  try {
    const Bonjour = resolveBonjourCtor(mod)
    const instance = new Bonjour()
    instance.publish({ name, type: MDNS_TYPE, port: denPort, txt })
    runtime.addShutdownHook(async () => {
      try {
        await new Promise<void>((resolve) => {
          instance.unpublishAll(resolve)
        })
      } catch {
        /* already unpublished */
      }
      try {
        instance.destroy()
      } catch {
        /* already destroyed */
      }
    })
  } catch (err) {
    log.warn(`mDNS advertise failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  log.info(`mDNS advertised ${name} as ${MDNS_TYPE} on port ${String(denPort)} (tls=${txt.tls})`)
}
