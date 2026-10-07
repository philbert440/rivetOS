/**
 * New thread: a prompt for an agent, or History in pick mode. Prompt is the
 * default. Esc / Cancel close without writing. From History hands the canvas
 * the target space; the panel places the chosen row.
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { HarnessDescriptor, ThinkingLevel } from '@rivetos/types'
import { useQueryClient } from '@tanstack/react-query'
import { dedupeRosterAgents, type ListedAgents } from '../../lib/agent-roster.js'
import { launchModelOptions } from '../../lib/conversation-model-options.js'
import { useConnection } from '../../stores/connection.js'
import { Select } from '../select.js'
import { EffortPicker } from '../pickers/effort-picker.js'
import { ModelPicker } from '../pickers/model-picker.js'
import { applyChooser, type PromptAgent } from './new-thread.js'

function readRoster(client: ReturnType<typeof useQueryClient>): ListedAgents[] {
  return client
    .getQueriesData<ListedAgents[]>({ queryKey: ['agents-all-nodes'] })
    .flatMap(([, data]) => data ?? [])
}

export function NewThreadDialog(props: {
  spaceId?: string
  spaces: { id: string; name: string }[]
  descriptors?: HarnessDescriptor[]
  onClose: () => void
  onStarted: (sessionId: string) => void
  onPickHistory: (spaceId: string) => void
}): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const roster = useConnection((s) => s.roster)
  const client = useQueryClient()
  const [lists, setLists] = useState<ListedAgents[]>(() => readRoster(client))
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        // queryKey is Query<any>'s key (tanstack); same cast as pages/chat.tsx.
        const key: unknown = (event.query.queryKey as readonly unknown[])[0]
        if (key === 'agents-all-nodes') setLists(readRoster(client))
      }),
    [client],
  )
  const agents = dedupeRosterAgents(lists, { currentBaseUrl: baseUrl, mesh: [], roster })
  const locked = props.spaceId
  const [spaceId, setSpaceId] = useState(locked ?? props.spaces[0]?.id ?? '')
  const [agentId, setAgentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<ThinkingLevel>('medium')
  const target = locked ?? spaceId
  const agent: PromptAgent | undefined = agents.find((row) => row.id === agentId)
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  useEffect(() => {
    const next = agentsRef.current.find((row) => row.id === agentId)
    if (!next) {
      setModel('')
      setEffort('medium')
      return
    }
    setModel(next.model ?? '')
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
  }, [agentId])

  const launch = launchModelOptions({
    preBind: true,
    harnessId: agent?.harnessId,
    registry: props.descriptors,
    model,
  })
  const modelOptions = [{ value: '', label: launch.defaultModelLabel }, ...launch.models]

  const start = (): void => {
    const id = applyChooser({
      type: 'prompt',
      prompt,
      spaceId: target,
      baseUrl,
      agent,
      model: model || undefined,
      effort,
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
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const field = document.getElementById('new-thread-prompt')
            if (field instanceof HTMLElement) field.focus()
          }}
        >
          <Dialog.Title className="mb-3 text-sm text-ink">New thread</Dialog.Title>
          <Dialog.Description className="sr-only">
            Send a prompt, or add a thread from History.
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
              onChange={setAgentId}
              aria-label="Agent"
              label="Agent"
              className="w-full"
            />
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
              disabled={!prompt.trim() || !target}
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
