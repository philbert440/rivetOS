/** Shared empty TLS + den fields for unit tests (loopback HTTP). */
import type { DenConfig, DenTlsFileConfig } from './config.js'

export const emptyTls = (): DenTlsFileConfig => ({
  certPath: '',
  keyPath: '',
  caPath: '',
  requireClientCert: true,
})

/** Minimal DenConfig for tests listening on loopback without TLS. */
export function baseTestDenConfig(
  stateDir: string,
  partial: Partial<DenConfig> & { port?: number; host?: string } = {},
): DenConfig {
  return {
    port: partial.port ?? 0,
    host: partial.host ?? '127.0.0.1',
    token: '',
    tls: partial.tls ?? emptyTls(),
    stateDir,
    staticDir: partial.staticDir ?? '',
    rootRedirect: partial.rootRedirect ?? '',
    evictTtlMs: partial.evictTtlMs ?? 60_000,
    meshFile: partial.meshFile ?? '',
    meshCacheMs: partial.meshCacheMs ?? 10_000,
    term: partial.term ?? {
      enabled: false,
      open: false,
      configFile: `${stateDir}/den-term.json`,
      maxPtys: 4,
      scrollbackBytes: 262_144,
      detachedTtlMs: 1_800_000,
      idleTtlMs: 1_800_000,
      exitLingerMs: 60_000,
      injectReadyMs: 10,
    },
    audio: partial.audio ?? {
      enabled: false,
      open: false,
      dir: '',
      deviceName: 'RivetHub Mic',
      sampleRate: 16_000,
    },
    filesRoot: partial.filesRoot ?? '',
    filesOpen: partial.filesOpen ?? false,
    devices: partial.devices,
    uploads: partial.uploads,
    pgUrl: partial.pgUrl,
  }
}
