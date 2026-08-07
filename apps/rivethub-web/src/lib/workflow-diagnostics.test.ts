import { describe, it, expect } from 'vitest'
import {
  shapeDiagnostic,
  shapeDiagnostics,
  diagnosticAbsolutePath,
  severityRank,
} from './workflow-diagnostics.js'

describe('shapeDiagnostic', () => {
  it('normalizes wire payloads', () => {
    expect(shapeDiagnostic({ file: 'run.ts', line: 3.9, severity: 'error', message: 'x' })).toEqual(
      {
        file: 'run.ts',
        line: 3,
        severity: 'error',
        message: 'x',
      },
    )
    expect(shapeDiagnostic({ file: 'a', message: 'm' })?.severity).toBe('error')
    expect(shapeDiagnostic(null)).toBeNull()
    expect(shapeDiagnostics([{ file: 'a', message: 'm' }, 'bad'])).toHaveLength(1)
  })
})

describe('diagnosticAbsolutePath', () => {
  it('joins editPath + relative file', () => {
    expect(diagnosticAbsolutePath('workflows/defs/demo', 'run.ts')).toBe(
      'workflows/defs/demo/run.ts',
    )
    expect(diagnosticAbsolutePath('', 'run.ts')).toBe('run.ts')
  })
})

describe('severityRank', () => {
  it('orders error < warning < info', () => {
    expect(severityRank('error')).toBeLessThan(severityRank('warning'))
    expect(severityRank('warning')).toBeLessThan(severityRank('info'))
  })
})
