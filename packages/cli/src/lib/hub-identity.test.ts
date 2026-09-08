import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { extraDeviceP12Path, rivethubMtlsDir, rivethubUserDataDir } from './hub-identity.js'

const HOME = '/home/tester'

describe('rivethubUserDataDir', () => {
  it('linux → ~/.config/RivetHub', () => {
    expect(rivethubUserDataDir('linux', HOME)).toBe(join(HOME, '.config', 'RivetHub'))
  })

  it('darwin → ~/Library/Application Support/RivetHub', () => {
    expect(rivethubUserDataDir('darwin', HOME)).toBe(
      join(HOME, 'Library', 'Application Support', 'RivetHub'),
    )
  })

  it('win32 → %APPDATA%\\RivetHub (or ~/AppData/Roaming/RivetHub)', () => {
    expect(rivethubUserDataDir('win32', HOME, 'C:\\Users\\tester\\AppData\\Roaming')).toBe(
      join('C:\\Users\\tester\\AppData\\Roaming', 'RivetHub'),
    )
    expect(rivethubUserDataDir('win32', HOME)).toBe(join(HOME, 'AppData', 'Roaming', 'RivetHub'))
  })
})

describe('rivethubMtlsDir', () => {
  it('nests mtls under userData (Electron identityDir)', () => {
    expect(rivethubMtlsDir('linux', HOME)).toBe(join(HOME, '.config', 'RivetHub', 'mtls'))
    expect(rivethubMtlsDir('darwin', HOME)).toBe(
      join(HOME, 'Library', 'Application Support', 'RivetHub', 'mtls'),
    )
  })
})

describe('extraDeviceP12Path', () => {
  it('writes ~/.rivetos/devices/<name>.p12', () => {
    expect(extraDeviceP12Path(HOME, 'phone')).toBe(join(HOME, '.rivetos', 'devices', 'phone.p12'))
  })
})
