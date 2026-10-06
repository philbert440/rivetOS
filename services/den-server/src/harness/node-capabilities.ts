/**
 * What this node can do, for a client that should hide controls instead of
 * probing routes and reading 501s. `drive` is historical-true: only an
 * explicit `false` (capture-only cowork) is read-only.
 */

import type { HarnessCapabilities, HarnessId } from '@rivetos/types'

export interface HarnessCapabilityRow {
  harnessId: HarnessId
  list: boolean
  read: boolean
  drive: boolean
  resume: boolean
}

export interface NodeCapabilities {
  subsystems: { den: true; devices: boolean; mesh: boolean }
  harnesses: HarnessCapabilityRow[]
}

export function nodeCapabilities(input: {
  devicesEnabled: boolean
  meshReadable: boolean
  harnesses: Array<{ harnessId: HarnessId; capabilities: HarnessCapabilities }>
}): NodeCapabilities {
  return {
    subsystems: {
      den: true,
      devices: input.devicesEnabled,
      mesh: input.meshReadable,
    },
    harnesses: input.harnesses.map((row) => ({
      harnessId: row.harnessId,
      list: row.capabilities.listSessions,
      read: row.capabilities.listSessions,
      drive: row.capabilities.drive !== false,
      resume: row.capabilities.resume,
    })),
  }
}
