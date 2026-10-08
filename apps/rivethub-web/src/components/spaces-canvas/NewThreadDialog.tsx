/**
 * New thread: a prompt for an agent, or History in pick mode. Prompt is the
 * default. Esc / Cancel close without writing. From History hands the canvas
 * the target space; the panel places the chosen row.
 *
 * When the chosen space has defaults, the Prompt fields start from them.
 * The agent is seeded first; the space's model and effort are applied
 * after that. Preset model and effort are copied only when the user picks
 * an agent, so a space override is not replaced on open — cached roster
 * or still loading. Switching space re-applies that space's overrides.
 * A preset that is no longer startable stays off the picker. Plain draft
 * does not copy that id (Ctrl+T still does). An explicit node that left
 * the connection roster is not used.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { HarnessDescriptor, ThinkingLevel } from '@rivetos/types'
import { launchModelOptions } from '../../lib/conversation-model-options.js'
import { urlLabel } from '../../lib/node-name.js'
import { useRosterAgents } from '../../lib/use-agent-roster.js'
import { useConnection } from '../../stores/connection.js'
import type { SpaceDefaults } from '../../stores/spaces.js'
import { Select } from '../select.js'
import { EffortPicker } from '../pickers/effort-picker.js'
import { ModelPicker } from '../pickers/model-picker.js'
import {
  applyChooser,
  initialThreadFields,
  offRosterStartNotice,
  resolveRosterNode,
  type PromptAgent,
  type SpaceRosterAgent,
  canStartThread,
} from './new-thread.js'
import { startsInDirectory } from './space-defaults.js'

export function NewThreadDialog(props: {
  spaceId?: string
  spaces: { id: string; name: string; defaults?: SpaceDefaults }[]
  descriptors?: HarnessDescriptor[]
  onClose: () => void
  onStarted: (sessionId: string) => void
  onPickHistory: (spaceId: string) => void
}): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const { agents: rosterAgents, isLoading } = useRosterAgents()
  const agents: SpaceRosterAgent[] = rosterAgents.filter((row) => row.sourceNodeBaseUrl.length > 0)
  const locked = props.spaceId
  const firstSpace = props.spaces.length > 0 ? props.spaces[0] : undefined
  const [spaceId, setSpaceId] = useState(locked ?? firstSpace?.id ?? '')
  const [agentId, setAgentId] = useState('')
  // True once the user picks an agent (including Plain draft) after seeding.
  const [agentTouched, setAgentTouched] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<ThinkingLevel>('medium')
  // Start stays shut until the space seed has landed. A stored preset's
  // roster row is not known while that query is loading.
  const [seedReady, setSeedReady] = useState(false)
  const target = locked ?? spaceId
  const defaults = props.spaces.find((space) => space.id === target)?.defaults
  const agent: PromptAgent | undefined = agents.find((row) => row.id === agentId)
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults
  const seededTarget = useRef<string | null>(null)

  useEffect(() => {
    if (seededTarget.current === target) return
    if (defaultsRef.current?.agentId && isLoading) {
      setSeedReady(false)
      return
    }
    // Agent first, then the space's model and effort. Preset model/effort
    // are applied only when the user picks an agent, so this seed is not
    // overwritten on the flush — cached roster or still loading.
    const fields = initialThreadFields(defaultsRef.current, agentsRef.current)
    seededTarget.current = target
    setAgentId(fields.agentId)
    setAgentTouched(false)
    setModel(fields.model)
    setEffort(fields.effort)
    setSeedReady(true)
  }, [target, isLoading])

  const applyAgentPick = (value: string): void => {
    setAgentId(value)
    setAgentTouched(true)
    const next = agents.find((row) => row.id === value)
    if (!next) {
      setModel('')
      setEffort('medium')
      return
    }
    setModel(next.model)
    const level = next.effort
    if (
      level === 'off' ||
      level === 'low' ||
      level === 'medium' ||
      level === 'high' ||
      level === 'xhigh'
    ) {
      setEffort(level)
    } else {
      setEffort('medium')
    }
  }

  const rosterUrls = useConnection((s) => s.roster).map((node) => node.baseUrl)
  const nodeCandidate = agent?.sourceNodeBaseUrl || (!agent ? defaults?.node : undefined)
  const nodeResolved = resolveRosterNode(nodeCandidate, baseUrl, rosterUrls)
  const nodeNotice = nodeResolved.unavailable
    ? offRosterStartNotice(nodeResolved.unavailable, baseUrl)
    : undefined

  const launch = launchModelOptions({
    preBind: true,
    harnessId: agent?.harnessId,
    registry: props.descriptors,
    model,
  })
  const modelOptions = [{ value: '', label: launch.defaultModelLabel }, ...launch.models]
  const directory = agents.find((row) => row.id === agentId)?.directory
  const startsIn = startsInDirectory(directory)

  // Same guard as the Start button: Enter must not start before the space's
  // defaults are seeded (an unseeded start would ignore the preset's node).
  const canStart = canStartThread({ prompt, target, seedReady })
  const start = (): void => {
    if (!canStart) return
    const id = applyChooser({
      type: 'prompt',
      prompt,
      spaceId: target,
      baseUrl,
      agent,
      model: model || undefined,
      effort,
      node: agent ? undefined : defaults?.node,
      missingPreset:
        !agent &&
        !agentTouched &&
        !isLoading &&
        defaults?.agentId &&
        !agents.some((row) => row.id === defaults.agentId)
          ? { agentId: defaults.agentId, harnessId: defaults.harnessId }
          : undefined,
    })
    if (!id) return
    props.onStarted(id)
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
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 w-[28rem] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 border border-line bg-panel p-4 font-mono shadow-lg outline-none"
          title={startsIn}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const field = document.getElementById('new-thread-prompt')
            if (field instanceof HTMLElement) field.focus()
          }}
        >
          <Dialog.Title className="mb-3 text-sm text-ink">New thread</Dialog.Title>
          <Dialog.Description className="sr-only">
            Send a prompt, or add a thread from History.
            {startsIn ? ` ${startsIn}.` : ''}
          </Dialog.Description>
          <div className="mb-3 flex gap-1" role="tablist" aria-label="How to start">
            <button
              type="button"
              role="tab"
              aria-selected="true"
              className="border border-em bg-em/15 px-3 py-1.5 text-xs text-em"
            >
              Prompt
            </button>
            <button
              type="button"
              role="tab"
              aria-selected="false"
              disabled={!target}
              className="border border-line px-3 py-1.5 text-xs text-ink-dim hover:border-em hover:text-em disabled:opacity-40"
              onClick={() => {
                if (target) props.onPickHistory(target)
              }}
            >
              From History
            </button>
          </div>
          {locked ? (
            <p className="mb-3 text-xs text-ink-dim">
              Space ·{' '}
              <span className="text-ink">{props.spaces.find((s) => s.id === locked)?.name}</span>
            </p>
          ) : (
            <div className="mb-3">
              <Select
                value={spaceId}
                options={props.spaces.map((space) => ({ value: space.id, label: space.name }))}
                onChange={setSpaceId}
                aria-label="Space"
                label="Space"
                className="w-full"
              />
            </div>
          )}
          <label className="mb-1 block text-xs text-ink-dim" htmlFor="new-thread-agent">
            Agent
          </label>
          <div className="mb-3" id="new-thread-agent">
            <Select
              value={agentId}
              options={[
                { value: '', label: 'Plain draft' },
                ...agents.map((row) => ({ value: row.id, label: row.name })),
              ]}
              onChange={applyAgentPick}
              aria-label="Agent"
              label="Agent"
              className="w-full"
            />
            {startsIn ? (
              <p className="mt-1 text-xs text-ink-dim">
                {startsIn}
                {agent?.sourceNodeBaseUrl
                  ? ` on ${agents.find((row) => row.id === agentId)?.node?.trim() || urlLabel(agent.sourceNodeBaseUrl)}`
                  : ''}
              </p>
            ) : null}
            {nodeNotice ? <p className="mt-1 text-xs text-ink-dim">{nodeNotice}</p> : null}
          </div>
          <label className="mb-1 block text-xs text-ink-dim" htmlFor="new-thread-prompt">
            What should it do?
          </label>
          <textarea
            id="new-thread-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                start()
              }
            }}
            rows={4}
            placeholder="What should it do?"
            className="mb-3 w-full resize-none border border-line bg-bg px-2 py-1.5 text-sm text-ink outline-none placeholder:text-ink-dim"
          />
          <div className="mb-4 flex flex-wrap items-center gap-1">
            <ModelPicker
              value={model}
              options={modelOptions}
              onChange={setModel}
              disabled={modelOptions.length === 0}
            />
            <EffortPicker value={effort} onChange={setEffort} />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={props.onClose}
              className="border border-line px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canStart}
              onClick={start}
              className="bg-em-dim px-3 py-1.5 text-xs font-medium text-bg hover:bg-em disabled:opacity-40"
            >
              Start
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
