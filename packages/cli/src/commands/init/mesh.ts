/**
 * Wizard step: join an existing RivetHub mesh via `rivetos mesh enroll`.
 */

import { hostname } from 'node:os'
import * as p from '@clack/prompts'
import { parseUserHost, validateNodeName } from '../../lib/mesh-enroll.js'
import type { WizardMeshJoin } from './types.js'

function bail<T>(v: T | symbol): asserts v is T {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
}

function defaultNodeName(): string {
  const host = hostname().split('.')[0]?.toLowerCase() ?? 'node'
  const cleaned = host.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  return validateNodeName(cleaned) ? cleaned : 'node'
}

/** After provider setup: ask whether this node joins a RivetHub mesh. */
export async function configureMeshJoin(): Promise<WizardMeshJoin | undefined> {
  p.log.step('RivetHub Mesh')
  const join = await p.confirm({
    message: 'Join a RivetHub mesh?',
    initialValue: false,
  })
  bail(join)
  if (!join) return undefined

  const hubResult = await p.text({
    message: 'Datahub SSH target (user@host)',
    placeholder: 'rivet@datahub',
    validate: (raw) => {
      const value = (raw ?? '').trim()
      if (!value) return 'Required.'
      try {
        parseUserHost(value)
      } catch (err) {
        return (err as Error).message
      }
      return undefined
    },
  })
  bail(hubResult)

  const nameDefault = defaultNodeName()
  const nameResult = await p.text({
    message: 'Node name',
    placeholder: nameDefault,
    defaultValue: nameDefault,
    validate: (raw) => {
      const value = (raw ?? '').trim()
      if (!value) return 'Required.'
      if (!validateNodeName(value)) {
        return 'Must match [a-z0-9]([a-z0-9-]*[a-z0-9])? (max 63)'
      }
      return undefined
    },
  })
  bail(nameResult)

  const advertiseResult = await p.text({
    message: 'Advertise host (optional — address other nodes use to reach this node)',
    placeholder: 'hostname or IP (leave blank to auto-detect)',
  })
  bail(advertiseResult)
  const advertise = advertiseResult.trim() ? advertiseResult.trim() : undefined

  return { hub: hubResult.trim(), name: nameResult.trim(), advertise }
}
