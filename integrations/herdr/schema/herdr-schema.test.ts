/**
 * herdr API schema contract — the methods/events the den herdr backend
 * (feat/den-herdr-backend) and the rivet-memory pane-identity hook depend
 * on, asserted against the pinned reference schema.
 *
 * The reference (`herdr-api.schema.json`, herdr 0.8.2, protocol 20) is
 * regenerated with scripts/herdr-schema-refresh.sh. A herdr version bump
 * that removes or reshapes a depended-on method fails HERE, in review —
 * not at runtime on a node.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface JsonObject {
  [key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(
  readFileSync(join(here, 'herdr-api.schema.json'), 'utf-8'),
) as JsonObject

const requestOneOf = schema.schemas.request.oneOf as JsonObject[]
const requestDefs = schema.schemas.request.$defs as JsonObject

function methodEntry(method: string): JsonObject | undefined {
  return requestOneOf.find((e) => e.properties?.method?.const === method)
}

/** params $defs name for a method, e.g. "WorkspaceCreateParams". */
function paramsDefName(method: string): string {
  const entry = methodEntry(method)
  expect(entry, `method ${method} missing from request schema`).toBeDefined()
  const ref = entry!.properties.params.$ref as string
  return ref.split('/').pop()!
}

function paramsDef(method: string): JsonObject {
  const name = paramsDefName(method)
  const def = requestDefs[name]
  expect(def, `params $def ${name} (for ${method}) missing`).toBeDefined()
  return def
}

describe('reference identity', () => {
  it('is the pinned protocol (herdr 0.8.2 = protocol 20)', () => {
    expect(schema.protocol).toBe(20)
  })
})

describe('methods the den backend depends on', () => {
  it('workspace.create — cwd/env/label/focus params', () => {
    const props = paramsDef('workspace.create').properties
    for (const p of ['cwd', 'env', 'label', 'focus']) {
      expect(props, `workspace.create lost param ${p}`).toHaveProperty(p)
    }
  })

  it('pane.list — optional workspace_id filter', () => {
    expect(paramsDef('pane.list').properties).toHaveProperty('workspace_id')
  })

  it('agent.start — requires name, kind, pane_id', () => {
    const def = paramsDef('agent.start')
    expect(def.required).toEqual(expect.arrayContaining(['name', 'kind', 'pane_id']))
  })

  it('agent.get — requires target', () => {
    expect(paramsDef('agent.get').required).toContain('target')
  })

  it('agent.read — requires target and source', () => {
    const def = paramsDef('agent.read')
    expect(def.required).toEqual(expect.arrayContaining(['target', 'source']))
  })

  it('agent.list — present', () => {
    expect(methodEntry('agent.list')).toBeDefined()
  })

  it('session.snapshot — present, and the snapshot result keeps its shape', () => {
    expect(methodEntry('session.snapshot')).toBeDefined()
    const snapshot = schema.schemas.success_response.$defs.SessionSnapshot
    expect(snapshot, 'SessionSnapshot result def missing').toBeDefined()
    expect(snapshot.required).toEqual(
      expect.arrayContaining([
        'version',
        'protocol',
        'workspaces',
        'tabs',
        'panes',
        'layouts',
        'agents',
      ]),
    )
    // AgentInfo rows carry the fields the backend joins on.
    const agentInfo = schema.schemas.success_response.$defs.AgentInfo
    for (const p of ['pane_id', 'agent_status', 'agent_session']) {
      expect(agentInfo.properties, `AgentInfo lost field ${p}`).toHaveProperty(p)
    }
  })

  it('events.subscribe — subscriptions array of Subscription', () => {
    const def = paramsDef('events.subscribe')
    expect(def.required).toContain('subscriptions')
    expect(def.properties.subscriptions.items.$ref).toContain('Subscription')
  })
})

describe('pane.agent_status_changed event', () => {
  it('is subscribable with a pane_id filter', () => {
    const sub = (requestDefs.Subscription.oneOf as JsonObject[]).find(
      (e) => e.properties?.type?.const === 'pane.agent_status_changed',
    )
    expect(sub, 'Subscription lost the pane.agent_status_changed variant').toBeDefined()
    expect(sub!.required).toEqual(expect.arrayContaining(['type', 'pane_id']))
  })

  it('is a known server event carrying pane/workspace/status', () => {
    const eventDefs = schema.schemas.event.$defs as JsonObject
    expect(eventDefs.EventKind.enum).toContain('pane_agent_status_changed')

    // The Event union entry (whichever $def holds the union).
    const union = Object.values(eventDefs).find(
      (d: JsonObject) =>
        Array.isArray(d.oneOf) &&
        d.oneOf.some((e: JsonObject) => e.properties?.type?.const === 'pane_agent_status_changed'),
    )
    expect(union, 'no event union carries pane_agent_status_changed').toBeDefined()
    const entry = (union as JsonObject).oneOf.find(
      (e: JsonObject) => e.properties?.type?.const === 'pane_agent_status_changed',
    )
    expect(entry.required).toEqual(
      expect.arrayContaining(['type', 'pane_id', 'workspace_id', 'agent_status']),
    )
    expect(eventDefs.AgentStatus.enum).toEqual(
      expect.arrayContaining(['idle', 'working', 'blocked']),
    )
  })

  it('is a deliverable subscription event kind', () => {
    const kinds = schema.schemas.subscription_event.$defs.SubscriptionEventKind.enum as string[]
    expect(kinds).toContain('pane.agent_status_changed')
  })
})

describe('pane.report_agent_session (rivet-memory pane-identity hook)', () => {
  it('requires pane_id, source, agent and accepts session id + path', () => {
    const def = paramsDef('pane.report_agent_session')
    expect(def.required).toEqual(expect.arrayContaining(['pane_id', 'source', 'agent']))
    for (const p of ['agent_session_id', 'agent_session_path']) {
      expect(def.properties, `pane.report_agent_session lost param ${p}`).toHaveProperty(p)
    }
  })
})
