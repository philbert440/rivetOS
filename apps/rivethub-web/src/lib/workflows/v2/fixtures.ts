/**
 * Golden legal / illegal IR v2 fixtures for validation tests.
 */

import type { WorkflowDefV2 } from './types.js'

/** Legal map: parent only touches map boundary; body fully internal. */
export const LEGAL_MAP_VERIFY: WorkflowDefV2 = {
  id: 'legal-map-verify',
  version: 1,
  name: 'Legal map verify',
  inputs: [{ id: 'doc', name: 'Doc', direction: 'in', kind: 'data', required: true }],
  outputs: [{ id: 'report', name: 'Report', direction: 'out', kind: 'data' }],
  triggers: [{ type: 'manual' }],
  graph: {
    nodes: [
      {
        kind: 'agent',
        id: 'ingest',
        label: 'Ingest',
        prompt: 'Load {{inputs.doc}}',
        exec: { capability: 'read-only' },
        inputs: [{ id: 'doc', name: 'Doc', direction: 'in', kind: 'data', required: true }],
        outputs: [{ id: 'bundle', name: 'Bundle', direction: 'out', kind: 'data' }],
      },
      {
        kind: 'map',
        id: 'verify',
        label: 'Verify each finding',
        items: { dialect: 'simple', expr: 'inputs.findings' },
        staticFanOut: 3,
        concurrency: 3,
        join: { policy: 'quorum', n: 2 },
        inputs: [
          { id: 'findings', name: 'Findings', direction: 'in', kind: 'data', required: true },
        ],
        outputs: [{ id: 'ok', name: 'Confirmed', direction: 'out', kind: 'data' }],
        bodyPortMap: {
          inputs: { findings: 'worker.in' },
          outputs: { ok: 'worker.out' },
        },
        body: {
          nodes: [
            {
              kind: 'agent',
              id: 'worker',
              label: 'Skeptic',
              prompt: 'Adversarially verify {{item}}',
              exec: { capability: 'read-only', tools: ['read_file'] },
              inputs: [{ id: 'in', name: 'Item', direction: 'in', kind: 'data', required: true }],
              outputs: [{ id: 'out', name: 'Verdict', direction: 'out', kind: 'data' }],
            },
          ],
          edges: [],
        },
      },
      {
        kind: 'tool',
        id: 'sink',
        label: 'Write report',
        tool: 'write_report',
        inputs: [{ id: 'in', name: 'In', direction: 'in', kind: 'data', required: true }],
        outputs: [{ id: 'out', name: 'Out', direction: 'out', kind: 'data' }],
      },
    ],
    edges: [
      {
        id: 'e1',
        from: { nodeId: 'ingest', portId: 'bundle' },
        to: { nodeId: 'verify', portId: 'findings' },
      },
      {
        id: 'e2',
        from: { nodeId: 'verify', portId: 'ok' },
        to: { nodeId: 'sink', portId: 'in' },
      },
    ],
  },
}

/** Illegal: parent edge targets a node id that only exists inside map body. */
export const ILLEGAL_REACH_THROUGH: WorkflowDefV2 = {
  id: 'illegal-reach-through',
  version: 1,
  name: 'Illegal reach-through',
  inputs: [],
  outputs: [],
  triggers: [{ type: 'manual' }],
  graph: {
    nodes: [
      {
        kind: 'agent',
        id: 'src',
        label: 'Src',
        prompt: 'hi',
        exec: { capability: 'read-only' },
        inputs: [],
        outputs: [{ id: 'out', name: 'Out', direction: 'out', kind: 'data' }],
      },
      {
        kind: 'map',
        id: 'm',
        label: 'Map',
        items: { dialect: 'simple', expr: 'x' },
        join: { policy: 'all' },
        inputs: [{ id: 'in', name: 'In', direction: 'in', kind: 'data' }],
        outputs: [{ id: 'out', name: 'Out', direction: 'out', kind: 'data' }],
        bodyPortMap: { inputs: { in: 'inner.in' }, outputs: { out: 'inner.out' } },
        body: {
          nodes: [
            {
              kind: 'agent',
              id: 'inner',
              label: 'Inner',
              prompt: 'work',
              exec: { capability: 'read-only' },
              inputs: [{ id: 'in', name: 'In', direction: 'in', kind: 'data' }],
              outputs: [{ id: 'out', name: 'Out', direction: 'out', kind: 'data' }],
            },
          ],
          edges: [],
        },
      },
    ],
    edges: [
      {
        id: 'bad',
        // reach-through: parent graph must not address body-only node
        from: { nodeId: 'src', portId: 'out' },
        to: { nodeId: 'inner', portId: 'in' },
      },
    ],
  },
}

/** Illegal: cycle at top level. */
export const ILLEGAL_CYCLE: WorkflowDefV2 = {
  id: 'illegal-cycle',
  version: 1,
  name: 'Cycle',
  inputs: [],
  outputs: [],
  triggers: [{ type: 'manual' }],
  graph: {
    nodes: [
      {
        kind: 'tool',
        id: 'a',
        label: 'A',
        tool: 't',
        inputs: [{ id: 'in', name: 'In', direction: 'in', kind: 'data' }],
        outputs: [{ id: 'out', name: 'Out', direction: 'out', kind: 'data' }],
      },
      {
        kind: 'tool',
        id: 'b',
        label: 'B',
        tool: 't',
        inputs: [{ id: 'in', name: 'In', direction: 'in', kind: 'data' }],
        outputs: [{ id: 'out', name: 'Out', direction: 'out', kind: 'data' }],
      },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'b', portId: 'in' } },
      { id: 'e2', from: { nodeId: 'b', portId: 'out' }, to: { nodeId: 'a', portId: 'in' } },
    ],
  },
}

/** Illegal: loop missing maxIterations / bad quorum. */
export const ILLEGAL_LOOP_AND_QUORUM: WorkflowDefV2 = {
  id: 'illegal-loop-quorum',
  version: 1,
  name: 'Bad loop and map',
  inputs: [],
  outputs: [],
  triggers: [{ type: 'manual' }],
  graph: {
    nodes: [
      {
        kind: 'loop',
        id: 'loop1',
        label: 'Loop',
        maxIterations: 0,
        until: { dialect: 'simple', expr: 'done' },
        while: { dialect: 'simple', expr: 'also' },
        body: { nodes: [], edges: [] },
        bodyPortMap: { inputs: {}, outputs: {} },
        inputs: [],
        outputs: [],
      },
      {
        kind: 'map',
        id: 'map1',
        label: 'Map',
        items: { dialect: 'simple', expr: 'xs' },
        staticFanOut: 2,
        join: { policy: 'quorum', n: 5 },
        body: { nodes: [], edges: [] },
        bodyPortMap: { inputs: {}, outputs: {} },
        inputs: [],
        outputs: [],
      },
    ],
    edges: [],
  },
}

/** Legal gate + agent judge composition. */
export const LEGAL_GATE_JUDGE: WorkflowDefV2 = {
  id: 'legal-gate-judge',
  version: 1,
  name: 'Judge then gate',
  inputs: [],
  outputs: [],
  triggers: [{ type: 'manual' }],
  graph: {
    nodes: [
      {
        kind: 'agent',
        id: 'judge',
        label: 'Judge',
        prompt: 'Return { verdict: boolean }',
        exec: { capability: 'read-only' },
        inputs: [],
        outputs: [
          {
            id: 'verdict',
            name: 'Verdict',
            direction: 'out',
            kind: 'data',
            schema: { type: 'object', properties: { verdict: { type: 'boolean' } } },
          },
        ],
      },
      {
        kind: 'gate',
        id: 'route',
        label: 'Route',
        predicate: { dialect: 'simple', expr: 'inputs.verdict == true' },
        inputs: [{ id: 'verdict', name: 'Verdict', direction: 'in', kind: 'data', required: true }],
        outputs: [
          { id: 'pass', name: 'Pass', direction: 'out', kind: 'control' },
          { id: 'fail', name: 'Fail', direction: 'out', kind: 'control' },
        ],
      },
    ],
    edges: [
      {
        id: 'e1',
        from: { nodeId: 'judge', portId: 'verdict' },
        to: { nodeId: 'route', portId: 'verdict' },
      },
    ],
  },
}
