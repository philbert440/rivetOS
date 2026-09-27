import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Read only the den scalar settings needed by hooks; no YAML runtime dependency.
function denSettings(raw: string): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {}
  let inDen = false
  for (const line of raw.split(/\r?\n/)) {
    if (/^den:\s*(?:#.*)?$/.test(line)) {
      inDen = true
      continue
    }
    if (/^\S/.test(line) && !line.startsWith('#')) inDen = false
    if (!inDen) continue
    const match = /^\s+(port|tls_ca):\s*("[^"]*"|'[^']*'|[^#]*)(?:\s*#.*)?$/.exec(line)
    if (match) result[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return result
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
): { denUrl: string; caPath?: string } | undefined {
  let config: Partial<Record<string, string>> = {}
  try {
    config = denSettings(readConfig() ?? '')
  } catch {
    /* Config is optional. */
  }
  const port = Number(config.port ?? 5174)
  const denUrl = env.RIVET_DEN_URL?.trim() || `https://127.0.0.1:${port}`
  try {
    const url = new URL(denUrl)
    if (!['https:', 'http:'].includes(url.protocol)) return undefined
  } catch {
    return undefined
  }
  return {
    denUrl,
    caPath:
      env.RIVET_DEN_CA?.trim() ||
      config.tls_ca ||
      env.RIVETOS_DEN_TLS_CA?.trim() ||
      '/rivet-shared/rivet-ca/intermediate/chain.pem',
  }
}
