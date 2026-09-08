/**
 * LAN mDNS advertiser — publishes `_rivethub._tcp` after the embedded den
 * gateway is listening so phones/desktops on the LAN can find this node.
 *
 * Gated on `den.advertise_mdns === true`. `bonjour-service` is loaded with
 * dynamic `import()` (boot compiles to CJS). A missing package warns and
 * does not fail boot — advertising is optional.
 *
 * Socket/send failures are warned, never thrown: an unhandled `'error'` on
 * the multicast-dns emitter would exit the whole rivetos process.
 */

import { hostname } from 'node:os'
import { logger } from '@rivetos/core'
import type { RivetConfig } from '../config.js'

const log = logger('Boot:Mdns')

const MDNS_TYPE = 'rivethub'
const MDNS_TXT_VERSION = '1'
/** Probe is ~750–1000 ms; warn if `up` never fires (lib swallows name conflicts). */
const PROBE_WARN_MS = 2000

interface BonjourService {
  name: string
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

/** bonjour-service instance surface we actually use. */
interface BonjourHandle {
  publish(opts: {
    name: string
    type: string
    port: number
    txt?: Record<string, string>
  }): BonjourService
  unpublishAll(callback?: () => void): void
  destroy(callback?: () => void): void
}

type BonjourCtor = new (opts?: object, errorCallback?: (err: unknown) => void) => BonjourHandle

/** bonjour-service keeps `server` private; multicast-dns is the 'error' emitter. */
type BonjourInternals = {
  server?: { mdns?: { on?: (event: string, fn: (err: unknown) => void) => void } }
}

export type MdnsBonjourLoader = () => Promise<unknown>

/** Returned closer: await goodbye packets, then destroy the socket. */
export type MdnsStop = () => Promise<void>

async function defaultLoadBonjour(): Promise<unknown> {
  return import('bonjour-service')
}

function resolveBonjourCtor(mod: unknown): BonjourCtor {
  if (typeof mod === 'function') return mod as BonjourCtor
  if (mod && typeof mod === 'object') {
    const rec = mod as { Bonjour?: unknown; default?: unknown }
    if (typeof rec.Bonjour === 'function') return rec.Bonjour as BonjourCtor
    if (typeof rec.default === 'function') return rec.default as BonjourCtor
  }
  throw new Error('bonjour-service export is not a constructor')
}

function warnMdnsError(err: unknown): void {
  log.warn(`mDNS error: ${err instanceof Error ? err.message : String(err)}`)
}

function attachMdnsErrorListener(instance: BonjourHandle, onError: (err: unknown) => void): void {
  const mdns = (instance as unknown as BonjourInternals).server?.mdns
  mdns?.on?.('error', onError)
}

function publishedInstanceName(service: BonjourService | undefined, rawName: string): string {
  const fromLib = service?.name?.trim()
  if (fromLib) return fromLib
  return rawName.split('.').join('-')
}

/**
 * Publish this node's den on mDNS when `config.den.advertise_mdns` is true.
 * `denPort` / `tlsConfigured` come from the successful `registerGateway` result.
 *
 * Returns a stop function (unpublish + destroy) when advertising, otherwise
 * `undefined`. Does not register a runtime shutdown hook — the caller composes
 * stop-then-`gateway.close()` so the goodbye packet goes out before den closes.
 *
 * `loadBonjour` is a test seam (defaults to `import('bonjour-service')`).
 */
export async function registerMdnsAdvertiser(
  config: RivetConfig,
  denPort: number,
  tlsConfigured: boolean,
  loadBonjour: MdnsBonjourLoader = defaultLoadBonjour,
): Promise<MdnsStop | undefined> {
  if (config.den?.advertise_mdns !== true) return undefined

  let mod: unknown
  try {
    mod = await loadBonjour()
  } catch (err) {
    log.warn(
      'den.advertise_mdns needs bonjour-service (dependency of @rivetos/boot) — install it: ' +
        (err instanceof Error ? err.message : String(err)),
    )
    return undefined
  }

  const rawName = hostname()
  const txt = { tls: tlsConfigured ? '1' : '0', v: MDNS_TXT_VERSION }

  let instance: BonjourHandle | undefined
  try {
    const Bonjour = resolveBonjourCtor(mod)
    instance = new Bonjour({}, warnMdnsError)

    let finished = false
    const conflictTimer: { current?: ReturnType<typeof setTimeout> } = {}
    const finish = (): void => {
      if (finished) return
      finished = true
      if (conflictTimer.current !== undefined) clearTimeout(conflictTimer.current)
    }

    attachMdnsErrorListener(instance, (err) => {
      warnMdnsError(err)
      finish()
    })

    const service = instance.publish({ name: rawName, type: MDNS_TYPE, port: denPort, txt })
    const name = publishedInstanceName(service, rawName)
    const handle = instance

    conflictTimer.current = setTimeout(() => {
      if (finished) return
      finished = true
      log.warn(`mDNS name in use or probe failed — ${name} not advertised`)
    }, PROBE_WARN_MS)
    ;(conflictTimer.current as { unref?: () => void }).unref?.()

    if (service && typeof service.on === 'function') {
      service.on('up', () => {
        if (finished) return
        finish()
        log.info(
          `mDNS advertised ${name} as ${MDNS_TYPE} on port ${String(denPort)} (tls=${txt.tls})`,
        )
      })
    }

    const stop: MdnsStop = async () => {
      finish()
      try {
        await new Promise<void>((resolve) => {
          handle.unpublishAll(resolve)
        })
      } catch {
        /* already unpublished */
      }
      try {
        handle.destroy()
      } catch {
        /* already destroyed */
      }
    }
    return stop
  } catch (err) {
    try {
      instance?.destroy()
    } catch {
      /* already destroyed */
    }
    log.warn(`mDNS advertise failed: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}
