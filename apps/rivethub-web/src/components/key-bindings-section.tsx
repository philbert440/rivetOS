/**
 * Settings → Keyboard. One row per action:
 * its current keys (× removes one), + records another, Reset restores the
 * default. A recorded key that would collide or swallow typing is refused
 * with the reason (lib/hub-keys `bindingProblem`). Esc cancels a recording.
 */

import { useEffect, useState, type JSX } from 'react'
import {
  bindingProblem,
  CANVAS_KEYS,
  HUB_KEYS,
  keysFor,
  type CanvasKeyEntry,
  type HubKeyEntry,
} from '../lib/hub-keys.js'
import { comboFromEvent, formatCombo, sameCombo } from '../lib/key-combo.js'
import { useKeyBindings } from '../stores/key-bindings.js'

type Entry = Pick<HubKeyEntry | CanvasKeyEntry, 'id' | 'name' | 'summary'>

function BindingRow(props: {
  entry: Entry
  recording: boolean
  onRecord: () => void
}): JSX.Element {
  const overrides = useKeyBindings((s) => s.overrides)
  const setBinding = useKeyBindings((s) => s.setBinding)
  const resetBinding = useKeyBindings((s) => s.resetBinding)
  const combos = keysFor(props.entry.id)
  const changed = Object.hasOwn(overrides, props.entry.id)
  return (
    <li data-binding-row={props.entry.id} className="flex flex-wrap items-center gap-2 py-1.5">
      <span className="w-40 shrink-0 text-xs text-ink" title={props.entry.summary}>
        {props.entry.name}
      </span>
      <span className="flex flex-1 flex-wrap items-center gap-1.5">
        {combos.length === 0 && !props.recording ? (
          <span className="text-xs text-ink-dim">unbound</span>
        ) : null}
        {combos.map((c) => (
          <span
            key={formatCombo(c)}
            className="inline-flex items-center gap-1 rounded border border-line bg-panel-2 px-2 py-0.5 font-mono text-xs text-em"
          >
            {formatCombo(c)}
            <button
              type="button"
              aria-label={`Remove ${formatCombo(c)} from ${props.entry.name}`}
              className="text-ink-dim hover:text-ink"
              onClick={() =>
                setBinding(
                  props.entry.id,
                  combos.filter((other) => !sameCombo(other, c)),
                )
              }
            >
              ×
            </button>
          </span>
        ))}
        {props.recording ? (
          <span
            data-recording=""
            className="rounded border border-em px-2 py-0.5 font-mono text-xs text-em"
          >
            Press keys… (Esc cancels)
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Add a shortcut for ${props.entry.name}`}
            className="rounded border border-dashed border-line px-2 py-0.5 font-mono text-xs text-ink-dim hover:border-em hover:text-em"
            onClick={props.onRecord}
          >
            +
          </button>
        )}
      </span>
      {changed ? (
        <button
          type="button"
          className="text-xs text-ink-dim hover:text-em"
          onClick={() => resetBinding(props.entry.id)}
        >
          Reset
        </button>
      ) : null}
    </li>
  )
}

export function KeyBindingsSection(): JSX.Element {
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | undefined>()
  const overrides = useKeyBindings((s) => s.overrides)
  const resetAll = useKeyBindings((s) => s.resetAll)
  const setRecording = useKeyBindings((s) => s.setRecording)

  // While recording, the live shortcut matchers stand down (store flag) and
  // the next non-modifier keypress becomes the new combo.
  useEffect(() => {
    if (recordingId === null) return
    setRecording(true)
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        setRecordingId(null)
        return
      }
      const next = comboFromEvent(e)
      if (!next) return
      const reason = bindingProblem(recordingId, next)
      if (reason) {
        setProblem(reason)
        return
      }
      const current = keysFor(recordingId)
      if (!current.some((c) => sameCombo(c, next))) {
        useKeyBindings.getState().setBinding(recordingId, [...current, next])
      }
      setProblem(undefined)
      setRecordingId(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      setRecording(false)
    }
  }, [recordingId, setRecording])

  const changedCount = Object.keys(overrides).length
  const group = (title: string, entries: readonly Entry[]): JSX.Element => (
    <div className="mt-4">
      <h3 className="mb-1 font-mono text-xs font-semibold text-ink-dim">{title}</h3>
      <ul className="divide-y divide-line">
        {entries.map((entry) => (
          <BindingRow
            key={entry.id}
            entry={entry}
            recording={recordingId === entry.id}
            onRecord={() => {
              setProblem(undefined)
              setRecordingId(entry.id)
            }}
          />
        ))}
      </ul>
    </div>
  )

  return (
    <>
      <h2 className="mt-10 mb-3 border-t border-line pt-6 font-mono text-sm font-semibold text-em">
        Keyboard shortcuts
        {changedCount > 0 ? (
          <span className="font-normal text-ink-dim"> · {changedCount} changed</span>
        ) : null}
      </h2>
      <div id="key-bindings">
        <p className="text-xs text-ink-dim">
          Click + and press a key to add a shortcut; × removes one. App shortcuts and the canvas
          zoom keys work while you type, so they need Ctrl, Alt or Super. Saved for this app on this
          device.
        </p>
        {problem ? (
          <p role="alert" data-binding-problem="" className="mt-2 text-xs text-warn">
            {problem}
          </p>
        ) : null}
        {group('App', HUB_KEYS)}
        {group('Canvas', CANVAS_KEYS)}
        {changedCount > 0 ? (
          <button
            type="button"
            className="mt-4 rounded border border-line bg-panel-2 px-3 py-1.5 text-xs hover:border-em"
            onClick={() => {
              setRecordingId(null)
              resetAll()
            }}
          >
            Reset all to defaults
          </button>
        ) : null}
      </div>
    </>
  )
}
