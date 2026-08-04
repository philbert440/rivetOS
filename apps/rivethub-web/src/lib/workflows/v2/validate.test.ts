import { describe, it, expect } from 'vitest'
import {
  ILLEGAL_CYCLE,
  ILLEGAL_LOOP_AND_QUORUM,
  ILLEGAL_REACH_THROUGH,
  LEGAL_GATE_JUDGE,
  LEGAL_MAP_VERIFY,
} from './fixtures.js'
import { isValidWorkflowV2, validateWorkflowV2 } from './validate.js'
import type { WorkflowDefV2 } from './types.js'

function codes(def: WorkflowDefV2, mode: 'structure' | 'executable' = 'executable'): string[] {
  return validateWorkflowV2(def, mode).map((i) => i.code)
}

describe('validateWorkflowV2 legal fixtures', () => {
  it('accepts legal map + quorum', () => {
    const issues = validateWorkflowV2(LEGAL_MAP_VERIFY)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(isValidWorkflowV2(LEGAL_MAP_VERIFY)).toBe(true)
  })

  it('accepts judge → gate composition', () => {
    expect(isValidWorkflowV2(LEGAL_GATE_JUDGE)).toBe(true)
  })
})

describe('validateWorkflowV2 illegal fixtures', () => {
  it('rejects reach-through to body-only node', () => {
    const c = codes(ILLEGAL_REACH_THROUGH)
    expect(c).toContain('edge.unknown_node')
    expect(c).toContain('edge.cross_boundary')
    expect(isValidWorkflowV2(ILLEGAL_REACH_THROUGH)).toBe(false)
  })

  it('rejects top-level cycles', () => {
    expect(codes(ILLEGAL_CYCLE)).toContain('graph.cycle')
  })

  it('rejects bad loop conditions and quorum > fanout', () => {
    const c = codes(ILLEGAL_LOOP_AND_QUORUM)
    expect(c).toContain('loop.bad_max_iterations')
    expect(c).toContain('loop.missing_condition')
    expect(c).toContain('map.quorum_exceeds_fanout')
  })

  it('flags agent missing prompt in executable mode only', () => {
    const def: WorkflowDefV2 = {
      id: 'a',
      version: 1,
      name: 'A',
      inputs: [],
      outputs: [],
      triggers: [{ type: 'manual' }],
      graph: {
        nodes: [
          {
            kind: 'agent',
            id: 'x',
            label: 'X',
            prompt: '  ',
            exec: { capability: 'read-only' },
            inputs: [],
            outputs: [],
          },
        ],
        edges: [],
      },
    }
    expect(codes(def, 'executable')).toContain('agent.missing_prompt')
    expect(codes(def, 'structure')).not.toContain('agent.missing_prompt')
  })
})

describe('body port map', () => {
  it('rejects map bodyPortMap pointing outside body', () => {
    const def: WorkflowDefV2 = {
      ...LEGAL_MAP_VERIFY,
      id: 'bad-map',
      graph: {
        ...LEGAL_MAP_VERIFY.graph,
        nodes: LEGAL_MAP_VERIFY.graph.nodes.map((n) => {
          if (n.kind !== 'map') return n
          return {
            ...n,
            bodyPortMap: {
              inputs: { findings: 'nope.in' },
              outputs: { ok: 'worker.out' },
            },
          }
        }),
      },
    }
    expect(codes(def)).toContain('map.bad_port_map')
  })
})
