/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * rivetos version
 */

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

export default async function version(): Promise<void> {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf-8'))
  let commit = ''
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim()
  } catch {
    /* expected */
  }

  const ver = `RivetOS v${pkg.version}`
  console.log(commit ? `${ver} (${commit})` : ver)
}
