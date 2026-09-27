import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { spoolBatch, spoolFiles } from './spool.js'

it('creates the directory and ignores temp files and dead letters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-'))
  try {
    const nested = join(dir, 'new')
    expect(await spoolFiles(nested)).toEqual([])
    await spoolBatch(nested, { session_key: 's', agent: 'a', messages: [] }, new Date(10))
    await writeFile(join(nested, '1-old.json.tmp'), 'partial')
    expect(await spoolFiles(nested)).toHaveLength(1)
    expect(await readdir(nested)).toHaveLength(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
