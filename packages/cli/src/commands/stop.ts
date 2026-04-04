/**
 * rivetos stop
 *
 * Sends SIGTERM to the running rivetos process.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const PID_FILE = resolve(process.env.HOME ?? '.', '.rivetos', 'rivetos.pid')

export default async function stop(): Promise<void> {
  try {
    const pid = parseInt(await readFile(PID_FILE, 'utf-8'))
    process.kill(pid, 'SIGTERM')
    console.log(`Sent SIGTERM to PID ${pid}`)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('No running instance found (no PID file).')
    } else if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      console.log('PID file exists but process is not running.')
    } else {
      throw err
    }
  }
}
