/**
 * rivetos status
 *
 * Shows whether the runtime is running and basic info.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const PID_FILE = resolve(process.env.HOME ?? '.', '.rivetos', 'rivetos.pid')
const VERSION = '0.1.0'

export default async function status(): Promise<void> {
  console.log(`RivetOS v${VERSION}`)
  console.log()

  // Check if running
  try {
    const pid = parseInt(await readFile(PID_FILE, 'utf-8'))
    try {
      process.kill(pid, 0) // signal 0 = check if alive
      console.log(`Status: ✅ Running (PID ${pid})`)
    } catch {
      console.log('Status: ❌ Not running (stale PID file)')
    }
  } catch {
    console.log('Status: 💤 Not running')
  }

  // Show config location
  const configCandidates = [
    resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml'),
    resolve('.', 'config.yaml'),
  ]

  for (const candidate of configCandidates) {
    try {
      await readFile(candidate)
      console.log(`Config: ${candidate}`)
      break
    } catch {
      /* expected */
    }
  }

  console.log(`Workspace: ${resolve(process.env.HOME ?? '.', '.rivetos', 'workspace')}`)
}
