/**
 * Contract-driven field form — shared by trigger page and gate resume card.
 * Types → inputs; required marked; description as help; issues inline.
 */

import type { JSX } from 'react'
import type { WorkflowField } from '@rivetos/types'
import type { FieldFormValues, FieldIssues } from '../lib/workflow-runs/form-fields.js'

export function WorkflowContractForm(props: {
  fields: readonly WorkflowField[]
  values: FieldFormValues
  issues?: FieldIssues
  disabled?: boolean
  onChange: (name: string, value: string) => void
  /** Optional id prefix for labels (avoid collisions when two forms on page). */
  idPrefix?: string
}): JSX.Element {
  const { fields, values, issues = {}, disabled, onChange, idPrefix = 'wf' } = props

  if (fields.length === 0) {
    return (
      <p className="text-sm text-ink-dim">No input fields — submit to start with empty input.</p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {fields.map((f) => {
        const id = `${idPrefix}-${f.name}`
        const issue = issues[f.name]
        const help = f.description
        return (
          <div key={f.name}>
            <label
              htmlFor={id}
              className="mb-1 flex items-baseline gap-2 font-mono text-xs text-ink"
            >
              <span>
                {f.name}
                {f.required !== false ? <span className="text-red"> *</span> : null}
              </span>
              <span className="text-ink-dim">{f.type}</span>
            </label>
            {f.type === 'boolean' ? (
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  id={id}
                  type="checkbox"
                  checked={values[f.name] === 'true'}
                  disabled={disabled}
                  onChange={(e) => onChange(f.name, e.target.checked ? 'true' : 'false')}
                  className="size-4 accent-em"
                />
                <span className="text-ink-dim">{values[f.name] === 'true' ? 'true' : 'false'}</span>
              </label>
            ) : f.type === 'json' ? (
              <textarea
                id={id}
                value={values[f.name] ?? ''}
                disabled={disabled}
                rows={3}
                spellCheck={false}
                placeholder="{}"
                onChange={(e) => onChange(f.name, e.target.value)}
                className={`w-full rounded border bg-panel-2 px-3 py-2 font-mono text-sm text-ink outline-none focus:border-em ${
                  issue ? 'border-red' : 'border-line'
                }`}
              />
            ) : (
              <input
                id={id}
                type={f.type === 'number' ? 'number' : 'text'}
                value={values[f.name] ?? ''}
                disabled={disabled}
                placeholder={f.type === 'file' ? 'path relative to caseDir' : undefined}
                onChange={(e) => onChange(f.name, e.target.value)}
                className={`w-full rounded border bg-panel-2 px-3 py-2 text-sm text-ink outline-none focus:border-em ${
                  f.type === 'file' || f.type === 'number' ? 'font-mono' : ''
                } ${issue ? 'border-red' : 'border-line'}`}
              />
            )}
            {help && !issue && <p className="mt-1 text-[11px] text-ink-dim">{help}</p>}
            {issue && <p className="mt-1 font-mono text-[11px] text-red">{issue}</p>}
          </div>
        )
      })}
    </div>
  )
}
