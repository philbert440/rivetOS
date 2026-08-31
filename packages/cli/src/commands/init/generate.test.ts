import { describe, it, expect } from 'vitest'
import { ENROLL_SNIPPET_MARKER } from '../../lib/mesh-enroll.js'
import { buildConfigYaml, meshSectionFromEnroll } from './generate.js'
import type { WizardState } from './types.js'

const SNIPPET = `${ENROLL_SNIPPET_MARKER}. Merge into the node's rivet.config.yaml.
mesh:
  enabled: true
  node_name: "ct110"
`

const baseState = (): WizardState => ({
  deployment: 'manual',
  agents: [{ name: 'rivet', provider: 'xai', model: 'grok-4-1-fast-reasoning', thinking: 'medium' }],
  channels: [],
  postgresPassword: 'secret',
  postgresUrl: 'postgres://u:p@localhost:5432/rivetos',
  ownerId: 'owner',
})

describe('meshSectionFromEnroll', () => {
  it('builds a valid mesh section from a fixture enroll result', () => {
    const section = meshSectionFromEnroll(
      { name: 'ct110', snippet: SNIPPET },
      '192.0.2.11',
    )
    expect(section).toEqual({
      enabled: true,
      node_name: 'ct110',
      tls: true,
      advertise_host: '192.0.2.11',
    })
  })

  it('fills tls even when the snippet omits it', () => {
    const section = meshSectionFromEnroll({
      name: 'node-a',
      snippet: 'mesh:\n  enabled: true\n  node_name: node-a\n',
    })
    expect(section.tls).toBe(true)
    expect(section.enabled).toBe(true)
    expect(section.node_name).toBe('node-a')
    expect(section.advertise_host).toBeUndefined()
  })

  it('still produces a mesh section when the snippet is unparseable', () => {
    const section = meshSectionFromEnroll({ name: 'phildesk', snippet: 'not: [yaml' })
    expect(section.node_name).toBe('phildesk')
    expect(section.enabled).toBe(true)
    expect(section.tls).toBe(true)
  })
})

describe('buildConfigYaml mesh branch', () => {
  it('omits mesh when enroll was not requested', () => {
    const yaml = buildConfigYaml(baseState())
    expect(yaml).not.toMatch(/^mesh:/m)
    expect(yaml).not.toContain('can be added manually')
  })

  it('writes the enroll mesh section into generated config', () => {
    const meshSection = meshSectionFromEnroll(
      { name: 'ct110', snippet: SNIPPET },
      '192.0.2.11',
    )
    const yaml = buildConfigYaml({ ...baseState(), meshSection })
    expect(yaml).toContain(ENROLL_SNIPPET_MARKER)
    expect(yaml).toMatch(/^mesh:/m)
    expect(yaml).toMatch(/enabled:\s*true/)
    expect(yaml).toMatch(/node_name:\s*"?ct110"?/)
    expect(yaml).toMatch(/tls:\s*true/)
    expect(yaml).toMatch(/advertise_host:\s*"?192\.0\.2\.11"?/)
  })

  it('omits advertise_host when enroll did not pass an explicit one', () => {
    const meshSection = meshSectionFromEnroll({ name: 'ct110', snippet: SNIPPET })
    const yaml = buildConfigYaml({ ...baseState(), meshSection })
    expect(yaml).toContain(ENROLL_SNIPPET_MARKER)
    expect(yaml).toMatch(/tls:\s*true/)
    expect(yaml).not.toMatch(/advertise_host:/)
  })
})
