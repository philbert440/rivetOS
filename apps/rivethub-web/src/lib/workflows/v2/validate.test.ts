import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  ILLEGAL_CYCLE,
  ILLEGAL_CYCLE_IN_BODY,
  ILLEGAL_LOOP_AND_QUORUM,
  ILLEGAL_REACH_THROUGH,
  ILLEGAL_TYPO_NODE,
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
    expect(validateWorkflowV2(LEGAL_MAP_VERIFY).filter((i) => i.severity === 'error')).toEqual([])
    expect(isValidWorkflowV2(LEGAL_MAP_VERIFY)).toBe(true)
  })

  it('accepts judge → gate composition', () => {
    expect(isValidWorkflowV2(LEGAL_GATE_JUDGE)).toBe(true)
  })
})

describe('validateWorkflowV2 illegal fixtures', () => {
  it('rejects reach-through to body-only node with cross_boundary', () => {
    const c = codes(ILLEGAL_REACH_THROUGH)
    expect(c).toContain('edge.unknown_node')
    expect(c).toContain('edge.cross_boundary')
  })

  it('typo node id is unknown_node only (not cross_boundary)', () => {
    const c = codes(ILLEGAL_TYPO_NODE)
    expect(c).toContain('edge.unknown_node')
    expect(c).not.toContain('edge.cross_boundary')
  })

  it('rejects top-level cycles', () => {
    expect(codes(ILLEGAL_CYCLE)).toContain('graph.cycle')
  })

  it('rejects cycles inside composite body', () => {
    expect(codes(ILLEGAL_CYCLE_IN_BODY)).toContain('graph.cycle_in_body')
  })

  it('rejects bad loop conditions and quorum > fanout', () => {
    const c = codes(ILLEGAL_LOOP_AND_QUORUM)
    expect(c).toContain('loop.bad_max_iterations')
    expect(c).toContain('loop.ambiguous_condition')
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

  it('validates gate predicate, script, approval, tool, dialect', () => {
    const def: WorkflowDefV2 = {
      id: 'bits',
      version: 1,
      name: 'Bits',
      inputs: [],
      outputs: [],
      triggers: [{ type: 'manual' }],
      graph: {
        nodes: [
          {
            kind: 'gate',
            id: 'g',
            label: 'G',
            // invalid predicate
            predicate: { dialect: 'nope', expr: '' } as never,
            inputs: [],
            outputs: [{ id: 'p', name: 'P', direction: 'out', kind: 'control' }],
          },
          {
            kind: 'script',
            id: 's',
            label: 'S',
            dialect: 'javascript' as never,
            source: '',
            inputs: [],
            outputs: [],
          },
          {
            kind: 'approval',
            id: 'ap',
            label: 'Ap',
            prompt: '',
            inputs: [],
            outputs: [],
          },
          {
            kind: 'tool',
            id: 't',
            label: 'T',
            tool: '',
            inputs: [],
            outputs: [],
          },
        ],
        edges: [],
      },
    }
    const c = codes(def)
    expect(c).toContain('expr.unknown_dialect')
    expect(c).toContain('gate.bad_predicate')
    expect(c).toContain('script.bad_dialect')
    expect(c).toContain('script.missing_source')
    expect(c).toContain('approval.missing_prompt')
    expect(c).toContain('tool.missing_tool')
  })

  it('does not throw on missing bodyPortMap (emits composite.missing_body_port_map)', () => {
    const def = {
      id: 'm',
      version: 1,
      name: 'M',
      inputs: [],
      outputs: [],
      triggers: [{ type: 'manual' }],
      graph: {
        nodes: [
          {
            kind: 'map',
            id: 'map1',
            label: 'Map',
            items: { dialect: 'simple', expr: 'x' },
            join: { policy: 'all' },
            body: { nodes: [], edges: [] },
            // bodyPortMap omitted — untrusted JSON
            inputs: [],
            outputs: [],
          },
        ],
        edges: [],
      },
    } as unknown as WorkflowDefV2
    expect(() => validateWorkflowV2(def)).not.toThrow()
    expect(codes(def)).toContain('composite.missing_body_port_map')
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
    expect(codes(def)).toContain('composite.invalid_body_port_map')
  })
})

describe('error code contract', () => {
  it('every code literal in validate.ts appears in VALIDATION.md index', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, 'validate.ts'), 'utf8')
    const doc = readFileSync(join(here, 'VALIDATION.md'), 'utf8')
    const codesInSrc = new Set(
      [...src.matchAll(/code:\s*'([a-z0-9_.]+)'/g)].map((m) => m[1]!),
    )
    // Also string templates that use code: variable — only check string literals
    expect(codesInSrc.size).toBeGreaterThan(10)
    const missing = [...codesInSrc].filter((c) => !doc.includes(`\`${c}\``) && !doc.includes(`| \`${c}\``) && !doc.includes(c))
    // Doc uses backtick codes in table
    const stillMissing = [...codesInSrc].filter((c) => !doc.includes(c))
    expect(stillMissing).toEqual([])
    expect(missing.length).toBeGreaterThanOrEqual(0) // silence unused if stillMissing catches all
  })
})
