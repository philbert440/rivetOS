import { describe, expect, it } from 'vitest'
import { EXPERIMENTAL_DEFAULTS, visibleNav, type ExperimentalFlags } from './visible-nav.js'

const PRIMARY = [
  { to: '/', label: 'Conversations' },
  { to: '/memory', label: 'Memory' },
  { to: '/files', label: 'Files' },
] as const

const SECONDARY = [
  { to: '/tasks', label: 'Tasks' },
  { to: '/workflows', label: 'Workflows' },
] as const

function labels(items: { label: string }[]): string[] {
  return items.map((i) => i.label)
}

describe('visibleNav', () => {
  it('hides Files / Tasks / Workflows when every flag is off', () => {
    expect(labels(visibleNav(PRIMARY, EXPERIMENTAL_DEFAULTS))).toEqual(['Conversations', 'Memory'])
    expect(labels(visibleNav(SECONDARY, EXPERIMENTAL_DEFAULTS))).toEqual([])
  })

  it('shows Files in primary only when files is on', () => {
    const on: ExperimentalFlags = { ...EXPERIMENTAL_DEFAULTS, files: true }
    expect(labels(visibleNav(PRIMARY, on))).toEqual(['Conversations', 'Memory', 'Files'])
    expect(labels(visibleNav(SECONDARY, on))).toEqual([])
  })

  it('shows Tasks and Workflows independently in secondary', () => {
    expect(labels(visibleNav(SECONDARY, { ...EXPERIMENTAL_DEFAULTS, tasks: true }))).toEqual([
      'Tasks',
    ])
    expect(labels(visibleNav(SECONDARY, { ...EXPERIMENTAL_DEFAULTS, workflows: true }))).toEqual([
      'Workflows',
    ])
    expect(
      labels(visibleNav(SECONDARY, { files: false, tasks: true, workflows: true })),
    ).toEqual(['Tasks', 'Workflows'])
  })

  it('never gates Conversations, Memory, or Settings', () => {
    const settings = [{ to: '/settings', label: 'Settings' }]
    expect(labels(visibleNav(PRIMARY, EXPERIMENTAL_DEFAULTS))).toContain('Conversations')
    expect(labels(visibleNav(PRIMARY, EXPERIMENTAL_DEFAULTS))).toContain('Memory')
    expect(labels(visibleNav(settings, EXPERIMENTAL_DEFAULTS))).toEqual(['Settings'])
    expect(
      labels(visibleNav(settings, { files: true, tasks: true, workflows: true })),
    ).toEqual(['Settings'])
  })
})
