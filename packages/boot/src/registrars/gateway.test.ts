import { describe, it, expect } from 'vitest'
import { buildGatewayEnv } from './gateway.js'
import type { RivetConfig } from '../config.js'

const base = (den: NonNullable<RivetConfig['den']>): RivetConfig => ({ den }) as RivetConfig

describe('buildGatewayEnv — device enrollment', () => {
  it('emits nothing when devices is absent or disabled', () => {
    expect(buildGatewayEnv(base({}), '/opt/rivetos').RIVETOS_DEN_DEVICES).toBeUndefined()
    expect(
      buildGatewayEnv(
        base({ devices: { enabled: false, pool: '10.0.0.1-10.0.0.9' } }),
        '/opt/rivetos',
      ).RIVETOS_DEN_DEVICES,
    ).toBeUndefined()
  })

  it('maps the devices section to the den-server env contract', () => {
    const env = buildGatewayEnv(
      base({
        devices: {
          enabled: true,
          relay_ssh: 'rivet@10.0.0.4',
          relay_sudo: true,
          wg_interface: 'wg0',
          pool: '10.0.0.32-10.0.0.63',
          wg_endpoint: '198.51.100.7:33050',
          wg_public_key: 'r'.repeat(43) + '=',
          allowed_ips: '10.0.0.0/24',
          home_subnet: '10.0.0.',
          shared_host: 'hub.local',
        },
      }),
      '/opt/rivetos',
    )
    expect(env.RIVETOS_DEN_DEVICES).toBe('1')
    expect(env.RIVETOS_DEN_DEVICES_RELAY_SSH).toBe('rivet@10.0.0.4')
    expect(env.RIVETOS_DEN_DEVICES_RELAY_SUDO).toBe('1')
    expect(env.RIVETOS_DEN_DEVICES_POOL).toBe('10.0.0.32-10.0.0.63')
    expect(env.RIVETOS_DEN_DEVICES_WG_ENDPOINT).toBe('198.51.100.7:33050')
    expect(env.RIVETOS_DEN_DEVICES_SHARED_HOST).toBe('hub.local')
  })

  it('omits relay_sudo when false and leaves optional keys unset', () => {
    const env = buildGatewayEnv(
      base({ devices: { enabled: true, pool: '10.0.0.1-10.0.0.9' } }),
      '/opt/rivetos',
    )
    expect(env.RIVETOS_DEN_DEVICES).toBe('1')
    expect(env.RIVETOS_DEN_DEVICES_RELAY_SUDO).toBeUndefined()
    expect(env.RIVETOS_DEN_DEVICES_RELAY_SSH).toBeUndefined()
  })
})
