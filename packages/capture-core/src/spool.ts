import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { CaptureBatch } from './types.js'

export async function spoolFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && /^\d+-[^/]+\.json$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || a.localeCompare(b))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function spoolBatch(dir: string, batch: CaptureBatch, now: Date): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${now.getTime()}-${randomUUID()}.json`)
  const temp = `${file}.tmp`
  try {
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(batch))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
    const directory = await open(dir, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return file
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export async function deadLetter(dir: string, file: string): Promise<void> {
  await mkdir(join(dir, 'dead'), { recursive: true, mode: 0o700 })
  await rename(join(dir, file), join(dir, 'dead', file))
}
