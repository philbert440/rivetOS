/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * rivetos version
 *
 * Reads the version from @rivetos/cli's own package.json — works from both a
 * source checkout and a `npm install -g` install (file is two levels up from
 * dist/commands/). If running from a git checkout, also appends the short
 * commit hash.
 */

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/commands → dist → package root
const PKG_ROOT = resolve(__dirname, '..', '..')

export default async function version(): Promise<void> {
  const pkg = JSON.parse(await readFile(resolve(PKG_ROOT, 'package.json'), 'utf-8'))
  let commit = ''
  try {
    commit = execSync('git rev-parse --short HEAD', {
      cwd: PKG_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    /* expected — not a git checkout (e.g. npm install -g) */
  }

  const ver = `RivetOS v${pkg.version}`
  console.log(commit ? `${ver} (${commit})` : ver)
}
