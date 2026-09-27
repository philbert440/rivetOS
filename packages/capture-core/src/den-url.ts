import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Read only the den scalar settings needed by hooks; no YAML runtime dependency.
function denSettings(raw: string): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {}
  let inDen = false
  let childIndent: number | undefined
  for (const line of raw.split(/\r?\n/)) {
    if (/^den:\s*(?:#.*)?$/.test(line)) {
      inDen = true
      childIndent = undefined
      continue
    }
    if (/^\S/.test(line) && !line.startsWith('#')) inDen = false
    if (!inDen) continue
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const indent = /^\s+/.exec(line)?.[0].length
    if (indent === undefined) continue
    childIndent ??= indent
    if (indent !== childIndent) continue
    const match = /^\s+(port|tls_ca):(.*)$/.exec(line)
    if (match && result[match[1]] === undefined) {
      result[match[1]] = match[2]
        .replace(/("[^"]*"|'[^']*')| #.*$/g, (_match, quoted: string | undefined) => quoted ?? '')
        .trim()
        .replace(/^("|')(.*)\1$/, '$2')
    }
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
  const port = /^\d+$/.test(config.port ?? '') ? Number(config.port) : 5174
  const denUrl = env.RIVET_DEN_URL?.trim() || `https://127.0.0.1:${port}`
  try {
    const url = new URL(denUrl)
    if (!['https:', 'http:'].includes(url.protocol)) return undefined
  } catch {
    return undefined
  }
  return {
    denUrl,
    // The launcher checks CA existence and disables den transport when it is missing.
    caPath:
      env.RIVET_DEN_CA?.trim() ||
      config.tls_ca ||
      env.RIVETOS_DEN_TLS_CA?.trim() ||
      '/rivet-shared/rivet-ca/intermediate/chain.pem',
  }
}
