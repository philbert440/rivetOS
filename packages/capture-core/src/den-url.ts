import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Den-related scalars a hook needs; no YAML runtime dependency. */
export interface DenConfigScalars {
  port?: string
  tls_ca?: string
  tls_cert?: string
  tls_key?: string
  /** `mesh.node_name` — the issue-node name whose cert files boot falls back to. */
  node_name?: string
}

// Read direct scalars under `den:` (and `node_name` under `mesh:`). Nested
// keys at a deeper indent than the first child are ignored; the first value
// wins; inline comments outside quotes are stripped.
function denSettings(raw: string): DenConfigScalars {
  const result: DenConfigScalars = {}
  const wanted: Record<string, ReadonlySet<keyof DenConfigScalars>> = {
    den: new Set(['port', 'tls_ca', 'tls_cert', 'tls_key']),
    mesh: new Set(['node_name']),
  }
  let section: string | undefined
  let childIndent: number | undefined
  for (const line of raw.split(/\r?\n/)) {
    const header = /^(den|mesh):\s*(?:#.*)?$/.exec(line)
    if (header) {
      section = header[1]
      childIndent = undefined
      continue
    }
    if (/^\S/.test(line) && !line.startsWith('#')) section = undefined
    if (!section) continue
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const indent = /^\s+/.exec(line)?.[0].length
    if (indent === undefined) continue
    childIndent ??= indent
    if (indent !== childIndent) continue
    const match = /^\s+([a-z_]+):(.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as keyof DenConfigScalars
    if (!wanted[section].has(key) || result[key] !== undefined) continue
    result[key] = match[2]
      .replace(/("[^"]*"|'[^']*')| #.*$/g, (_match, quoted: string | undefined) => quoted ?? '')
      .trim()
      .replace(/^("|')(.*)\1$/, '$2')
  }
  return result
}

export interface ResolveDenUrlProbes {
  /** Test seam for the mesh issue-node cert/key existence check. */
  exists?: (path: string) => boolean
}

/**
 * True when this node's embedded den serves HTTPS. Mirrors boot's
 * `resolveDenTls` / den-server `tlsReady`: `den.tls_cert` + `den.tls_key`,
 * else `RIVETOS_DEN_TLS_CERT`/`KEY`, else the mesh issue-node files
 * `<shared>/rivet-ca/issued/<mesh.node_name>.{crt,key}` when both exist.
 */
export function denTlsConfigured(
  env: NodeJS.ProcessEnv,
  config: DenConfigScalars,
  exists: (path: string) => boolean = existsSync,
): boolean {
  let cert = config.tls_cert || env.RIVETOS_DEN_TLS_CERT?.trim() || ''
  let key = config.tls_key || env.RIVETOS_DEN_TLS_KEY?.trim() || ''
  if ((!cert || !key) && config.node_name) {
    const shared = env.RIVETOS_SHARED_DIR?.trim() || '/rivet-shared'
    const issued = join(shared, 'rivet-ca', 'issued')
    if (!cert && exists(join(issued, `${config.node_name}.crt`))) {
      cert = join(issued, `${config.node_name}.crt`)
    }
    if (!key && exists(join(issued, `${config.node_name}.key`))) {
      key = join(issued, `${config.node_name}.key`)
    }
  }
  return Boolean(cert && key)
}

const LOOPBACK_HTTP = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/

/**
 * Normalize a pre-set `RIVET_DEN_URL`. Two guards, each one warning:
 *
 * - A comma list (the old den-hook fallback form) is not one origin; the
 *   first entry is used.
 * - A plain-http loopback URL against a den that serves https is rewritten
 *   to https. The den answers one scheme per port, and the stale value
 *   otherwise fails inside every capture (2026-09-27: `~/.rivetos/.env`
 *   kept `http://` from before gateway TLS and overrode the correct
 *   `https://` the den injects into its own sessions).
 *
 * Mirrors `rivetos_guard_den_url` in integrations/shared/rivet-paths.sh.
 */
export function guardDenUrl(
  raw: string,
  tlsConfigured: boolean,
): { denUrl: string; warnings: string[] } {
  const warnings: string[] = []
  let url = raw.trim()
  if (url.includes(',')) {
    const first = url.split(',')[0].trim()
    warnings.push(
      `RIVET_DEN_URL lists several origins; den transport uses one — using ${first} (fix ~/.rivetos/.env)`,
    )
    url = first
  }
  if (tlsConfigured && LOOPBACK_HTTP.test(url)) {
    const fixed = `https://${url.slice('http://'.length)}`
    warnings.push(
      `RIVET_DEN_URL=${url} but this den serves https only — using ${fixed}; set RIVET_DEN_URL=${fixed} in ~/.rivetos/.env or remove the line`,
    )
    url = fixed
  }
  return { denUrl: url, warnings }
}

export function resolveDenUrl(
  env: NodeJS.ProcessEnv,
  readConfig: () => string | undefined = () => {
    try {
      return readFileSync(join(homedir(), '.rivetos', 'config.yaml'), 'utf8')
    } catch {
      return undefined
    }
  },
  probes: ResolveDenUrlProbes = {},
): { denUrl: string; caPath?: string; warnings?: string[] } | undefined {
  let config: DenConfigScalars = {}
  try {
    config = denSettings(readConfig() ?? '')
  } catch {
    /* Config is optional. */
  }
  const port = /^\d+$/.test(config.port ?? '') ? Number(config.port) : 5174
  const preset = env.RIVET_DEN_URL?.trim()
  let denUrl = `https://127.0.0.1:${port}`
  let warnings: string[] = []
  if (preset) {
    const guarded = guardDenUrl(preset, denTlsConfigured(env, config, probes.exists))
    denUrl = guarded.denUrl
    warnings = guarded.warnings
  }
  try {
    const url = new URL(denUrl)
    if (!['https:', 'http:'].includes(url.protocol)) return undefined
  } catch {
    return undefined
  }
  return {
    denUrl,
    // The launcher checks CA existence for an https URL and disables den
    // transport when it is missing; a plain-http den needs no CA and is kept.
    caPath:
      env.RIVET_DEN_CA?.trim() ||
      config.tls_ca ||
      env.RIVETOS_DEN_TLS_CA?.trim() ||
      '/rivet-shared/rivet-ca/intermediate/chain.pem',
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
