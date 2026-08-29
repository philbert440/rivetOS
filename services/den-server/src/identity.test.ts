import { describe, expect, it } from 'vitest'
import { registryFromEnv, resolveUser } from '@rivetos/types'
import { captureEnvFor } from './identity.js'

const cocoDb = { pgUrl: 'postgres://coco@db/coco_memory', envFile: '/tmp/coco.env' }
const philDb = { pgUrl: 'postgres://phil@db/phil_memory' }

describe('captureEnvFor', () => {
  const reg = registryFromEnv({
    deviceUsers: { 'win-coco': 'coco' },
    userDbs: { coco: cocoDb },
    ownerPgUrl: philDb.pgUrl,
  })!

  it('does not emit env for the owner (main store stays the process default)', () => {
    const r = resolveUser(reg, null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(captureEnvFor(r.ctx)).toBeUndefined()
  })

  it('emits USER_ID + PG_URL for coco and never USER_DBS', () => {
    const r = resolveUser(reg, 'win-coco')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const env = captureEnvFor(r.ctx)
    expect(env).toEqual({
      RIVETOS_USER_ID: 'coco',
      RIVETOS_PG_URL: cocoDb.pgUrl,
      RIVETOS_ENV_FILE: cocoDb.envFile,
    })
    expect(env && 'RIVETOS_USER_DBS' in env).toBe(false)
  })
})
