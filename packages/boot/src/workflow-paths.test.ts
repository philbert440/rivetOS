import { describe, expect, it } from 'vitest'
import { anchorWorkflowPaths, type WorkflowsSection } from './config.js'

describe('anchorWorkflowPaths', () => {
  it('resolves relative runs_dir and defs_roots against the launch dir', () => {
    const section: WorkflowsSection = {
      runs_dir: './.dev/workflows/runs',
      defs_roots: ['./workflows', '/rivet-shared/workflows/defs'],
    }
    anchorWorkflowPaths(section, '/repo')
    expect(section.runs_dir).toBe('/repo/.dev/workflows/runs')
    expect(section.defs_roots).toEqual(['/repo/workflows', '/rivet-shared/workflows/defs'])
  })

  it('expands a leading ~ to HOME', () => {
    const section: WorkflowsSection = { defs_roots: ['~/defs'] }
    anchorWorkflowPaths(section, '/repo')
    expect(section.defs_roots).toEqual([`${process.env.HOME ?? '~'}/defs`])
  })

  it('leaves empty entries and a missing section alone', () => {
    const section: WorkflowsSection = { runs_dir: '  ', defs_roots: [''] }
    anchorWorkflowPaths(section, '/repo')
    expect(section).toEqual({ runs_dir: '  ', defs_roots: [''] })
    expect(() => anchorWorkflowPaths(undefined, '/repo')).not.toThrow()
  })
})
