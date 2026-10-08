/**
 * Edit a space: name plus optional defaults for threads started here.
 * Running threads are not rewritten. The directory line is the preset's
 * own directory, shown read-only — the client never stores or sends a cwd.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { HarnessDescriptor, HarnessId, ThinkingLevel } from '@rivetos/types'
import { launchModelOptions } from '../../lib/conversation-model-options.js'
import { urlLabel } from '../../lib/node-name.js'
import { useRosterAgents } from '../../lib/use-agent-roster.js'
import { useSpaces, type SpaceDef } from '../../stores/spaces.js'
import { Select } from '../select.js'
import { EffortPicker } from '../pickers/effort-picker.js'
import { ModelPicker } from '../pickers/model-picker.js'
import { NodePicker } from '../pickers/node-picker.js'
import type { SpaceRosterAgent } from './new-thread.js'
import { startsInDirectoryOn } from './space-defaults.js'

export function SpaceDefaultsDialog(props: {
  space: SpaceDef
  descriptors?: HarnessDescriptor[]
  onClose: () => void
}): JSX.Element {
  const stored = props.space.defaults
  const { agents: rosterAgents, isLoading } = useRosterAgents()
  const agents: SpaceRosterAgent[] = rosterAgents.filter((row) => row.sourceNodeBaseUrl.length > 0)
  const [name, setName] = useState(props.space.name)
  const [agentId, setAgentId] = useState('')
  const [missingId, setMissingId] = useState<string | undefined>(undefined)
  const [model, setModel] = useState(stored?.model ?? '')
  const [effort, setEffort] = useState<ThinkingLevel | undefined>(stored?.effort)
  const [node, setNode] = useState(stored?.node ?? '')
  // A stored preset must not be saved as "none" while the roster query is
  // still in flight — that write clears agentId and harnessId.
  const [ready, setReady] = useState(!stored?.agentId)
  const seeded = useRef(false)

  useEffect(() => {
    if (seeded.current) return
    const storedAgent = stored?.agentId
    if (storedAgent && isLoading) return
    seeded.current = true
    const found = agents.find((row) => row.id === storedAgent)
    if (storedAgent && !found) {
      setMissingId(storedAgent)
      setAgentId('')
    } else {
      setMissingId(undefined)
      setAgentId(found?.id ?? '')
    }
    setReady(true)
  }, [agents, isLoading, stored])

  const agent = agents.find((row) => row.id === agentId)
  const harnessId: HarnessId | undefined =
    agent?.harnessId ?? (missingId ? stored?.harnessId : undefined)
  const launch = launchModelOptions({
    preBind: true,
    harnessId,
    registry: props.descriptors,
    model,
  })
  // A stored model from the previous harness must not stay selected once
  // the new sheet does not offer it. Same rule as the chat launch picker.
  useEffect(() => {
    if (launch.clearModel) setModel('')
  }, [launch.clearModel])
  const modelOptions = [{ value: '', label: 'None' }, ...launch.models]
  const nodeLabel = agent?.node?.trim() || (agent ? urlLabel(agent.sourceNodeBaseUrl) : '')
  const startsIn = startsInDirectoryOn(agent?.directory, nodeLabel)
  const showNode = ready && !agent && !missingId

  const save = (): void => {
    if (!ready) return
    const trimmed = name.trim()
    if (!trimmed) return
    let nextAgent: string | undefined
    let nextHarness: HarnessId | undefined
    let nextNode: string | undefined
    if (missingId && !agent) {
      nextAgent = missingId
      nextHarness = stored?.harnessId
      nextNode = stored?.node
    } else if (agent) {
      nextAgent = agent.id
      nextHarness = agent.harnessId
      nextNode = undefined
    } else {
      nextAgent = undefined
      nextHarness = undefined
      nextNode = node || undefined
    }
    const patch: {
      agentId?: string
      model?: string
      effort?: ThinkingLevel
      harnessId?: HarnessId
      node?: string
    } = {
      agentId: nextAgent,
      model: model || undefined,
      effort,
      harnessId: nextHarness,
      node: nextNode,
    }
    useSpaces.getState().renameSpace(props.space.id, trimmed)
    useSpaces.getState().setSpaceDefaults(props.space.id, patch)
    props.onClose()
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[28rem] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 border border-line bg-panel p-4 font-mono shadow-lg outline-none">
          <Dialog.Title className="mb-3 text-sm text-ink">Edit space</Dialog.Title>
          <Dialog.Description className="mb-3 text-xs text-ink-dim">
            New threads in this space start with these. Threads already running are not changed.
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <label className="mb-1 block text-xs text-ink-dim" htmlFor="space-name">
              Name
            </label>
            <input
              id="space-name"
              autoFocus
              aria-label="Space name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Space name"
              className="mb-3 w-full border border-line bg-bg px-2 py-1.5 text-sm text-ink outline-none"
            />
            <label className="mb-1 block text-xs text-ink-dim" htmlFor="space-agent">
              Agent
            </label>
            {missingId ? (
              <p className="mb-2 flex items-center justify-between gap-2 text-xs text-ink-dim">
                <span>(missing preset)</span>
                <button
                  type="button"
                  aria-label="Clear missing preset"
                  className="border border-line px-2 py-1 text-ink hover:text-em"
                  onClick={() => setMissingId(undefined)}
                >
                  Clear
                </button>
              </p>
            ) : null}
            <div className="mb-3" id="space-agent">
              <Select
                value={agentId}
                options={[
                  { value: '', label: 'None' },
                  ...agents.map((row) => ({ value: row.id, label: row.name })),
                ]}
                onChange={(value) => {
                  setAgentId(value)
                  if (value) setMissingId(undefined)
                }}
                aria-label="Agent"
                label="Agent"
                className="w-full"
              />
              {startsIn ? <p className="mt-1 text-xs text-ink-dim">{startsIn}</p> : null}
            </div>
            <div className="mb-3">
              <span className="mb-1 block text-xs text-ink-dim">Model</span>
              <ModelPicker
                value={model}
                options={modelOptions}
                onChange={(value) => setModel(value)}
              />
            </div>
            <div className="mb-3">
              <span className="mb-1 block text-xs text-ink-dim">Effort</span>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  aria-pressed={effort === undefined}
                  aria-label="No default effort"
                  onClick={() => setEffort(undefined)}
                  className={`border px-2 py-1 text-xs ${
                    effort === undefined ? 'border-em text-em' : 'border-line text-ink-dim'
                  }`}
                >
                  None
                </button>
                {effort !== undefined ? (
                  <EffortPicker value={effort} onChange={setEffort} />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEffort('medium')}
                    className="border border-line px-2 py-1 text-xs text-ink-dim hover:text-ink"
                  >
                    Choose
                  </button>
                )}
              </div>
            </div>
            {showNode ? (
              <div className="mb-3">
                <span className="mb-1 block text-xs text-ink-dim">Node</span>
                <NodePicker selected={node} onSelect={setNode} />
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={props.onClose}
                className="border border-line px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim() || !ready}
                className="bg-em-dim px-3 py-1.5 text-xs font-medium text-bg hover:bg-em disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
