/**
 * Workflows edit mode — file tree of the def dir + shared FileEditor +
 * structured overlays (manifest form, agent cards) that re-parse the same
 * bytes. Validate button runs POST /api/workflows/:id/validate.
 */

import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { WorkflowDiagnostic, WorkflowField } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { FileEditor } from './file-editor.js'
import { baseName, joinRel } from '../lib/files-ui.js'
import {
  agentFieldsFromConfig,
  configFromAgentFields,
  joinFrontmatter,
  splitFrontmatter,
  type AgentFrontmatterFields,
} from '../lib/frontmatter.js'
import {
  emptyManifestForm,
  manifestFormFromRaw,
  rawFromManifestForm,
  type ManifestFormState,
} from '../lib/workflow-manifest-form.js'
import {
  diagnosticAbsolutePath,
  shapeDiagnostics,
  severityRank,
} from '../lib/workflow-diagnostics.js'

type TreeNode = {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

async function listTree(dir: string): Promise<TreeNode[]> {
  const gw = useConnection.getState().gateway
  const listing = await gw.filesList(dir)
  const nodes: TreeNode[] = []
  for (const e of listing.entries) {
    const child = joinRel(dir, e.name)
    if (e.type === 'dir') {
      nodes.push({
        name: e.name,
        path: child,
        type: 'dir',
        children: await listTree(child),
      })
    } else {
      nodes.push({ name: e.name, path: child, type: 'file' })
    }
  }
  // Dirs first, then files, each alphabetical — def dirs are tiny, sort here.
  nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  )
  return nodes
}

function flattenFiles(nodes: TreeNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.path)
    else if (n.children) out.push(...flattenFiles(n.children))
  }
  return out
}

function isManifestPath(editPath: string, filePath: string): boolean {
  return filePath === joinRel(editPath, 'workflow.yaml')
}

function isAgentPath(editPath: string, filePath: string): boolean {
  const agentsDir = joinRel(editPath, 'agents')
  return (
    filePath.startsWith(agentsDir + '/') &&
    filePath.endsWith('.md') &&
    !filePath.slice(agentsDir.length + 1).includes('/')
  )
}

export function WorkflowEditPanel(props: {
  workflowId: string
  editPath: string
  /** Reports unsaved-edit state so the parent can guard mode/nav switches. */
  onDirtyChange?: (dirty: boolean) => void
}): JSX.Element {
  const { workflowId, editPath, onDirtyChange } = props
  const baseUrl = useConnection((s) => s.baseUrl)
  const queryClient = useQueryClient()

  const [selected, setSelected] = useState(() => joinRel(editPath, 'workflow.yaml'))
  const [viewMode, setViewMode] = useState<'raw' | 'form'>('form')
  const [fileText, setFileText] = useState<string>('')
  const [textEpoch, setTextEpoch] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [diagnostics, setDiagnostics] = useState<WorkflowDiagnostic[]>([])
  const [validateMsg, setValidateMsg] = useState<string | undefined>()
  const [validating, setValidating] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [textLoading, setTextLoading] = useState(true)

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const treeQuery = useQuery({
    queryKey: ['workflow-edit-tree', baseUrl, editPath],
    queryFn: () => listTree(editPath),
  })

  // Load selected file text (SoT for both raw + form views). On load failure
  // the error stays OUT of fileText — error text must never be savable as
  // file content; the editor renders read-only empty with the error banner.
  // While a load is in flight nothing editable renders — otherwise the editor
  // would remount with the PREVIOUS file's bytes against the new path and a
  // quick save would cross-write files.
  useEffect(() => {
    let cancelled = false
    setDirty(false)
    setLoadError(undefined)
    setTextLoading(true)
    void useConnection
      .getState()
      .gateway.filesReadText(selected)
      .then((t) => {
        if (cancelled) return
        setFileText(t)
        setTextEpoch((e) => e + 1)
        setTextLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
        setFileText('')
        setTextEpoch((e) => e + 1)
        setTextLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  // Prefer form view for manifest + agents; raw for everything else
  useEffect(() => {
    if (isManifestPath(editPath, selected) || isAgentPath(editPath, selected)) {
      setViewMode('form')
    } else {
      setViewMode('raw')
    }
  }, [selected, editPath])

  const onSelectFile = (path: string): void => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return
    setSelected(path)
  }

  const saveText = useCallback(
    async (text: string): Promise<void> => {
      await useConnection.getState().gateway.filesSave(selected, text)
      setFileText(text)
      setDirty(false)
      await queryClient.invalidateQueries({
        queryKey: ['workflow-edit-tree', baseUrl, editPath],
      })
      await queryClient.invalidateQueries({
        queryKey: ['workflow', baseUrl, workflowId],
      })
    },
    [selected, queryClient, baseUrl, editPath, workflowId],
  )

  const onValidate = async (): Promise<void> => {
    setValidating(true)
    setValidateMsg(undefined)
    try {
      const res = await useConnection.getState().gateway.validateWorkflow(workflowId)
      const diags = shapeDiagnostics(res.diagnostics).sort(
        (a, b) => severityRank(a.severity) - severityRank(b.severity),
      )
      setDiagnostics(diags)
      setValidateMsg(res.ok ? 'ok — no errors' : `${String(diags.length)} diagnostic(s)`)
    } catch (err) {
      setValidateMsg(err instanceof Error ? err.message : String(err))
      setDiagnostics([])
    } finally {
      setValidating(false)
    }
  }

  const jumpToDiagnostic = (d: WorkflowDiagnostic): void => {
    const abs = diagnosticAbsolutePath(editPath, d.file)
    if (dirty && abs !== selected && !window.confirm('Discard unsaved changes?')) return
    setSelected(abs)
  }

  const showFormToggle = isManifestPath(editPath, selected) || isAgentPath(editPath, selected)

  return (
    <div className="flex min-h-[28rem] flex-col rounded border border-line bg-panel/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-xs text-ink-dim">edit · {editPath}</span>
        <button
          type="button"
          disabled={validating}
          onClick={() => void onValidate()}
          className="ml-auto rounded border border-line px-2 py-0.5 font-mono text-[11px] hover:border-em disabled:opacity-40"
        >
          {validating ? 'Validating…' : 'Validate'}
        </button>
        {validateMsg && (
          <span
            className={`font-mono text-[11px] ${
              diagnostics.some((d) => d.severity === 'error') ? 'text-red' : 'text-em'
            }`}
          >
            {validateMsg}
          </span>
        )}
      </div>

      {diagnostics.length > 0 && (
        <ul className="max-h-28 overflow-y-auto border-b border-line px-3 py-2 font-mono text-[11px]">
          {diagnostics.map((d, i) => (
            <li key={`${d.file}:${String(d.line ?? '')}:${String(i)}`}>
              <button
                type="button"
                onClick={() => jumpToDiagnostic(d)}
                className={`text-left hover:underline ${
                  d.severity === 'error' ? 'text-red' : 'text-ink-dim'
                }`}
              >
                {d.severity} · {d.file}
                {d.line !== undefined ? `:${String(d.line)}` : ''} — {d.message}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex min-h-0 flex-1">
        {/* File tree */}
        <nav className="w-48 shrink-0 overflow-y-auto border-r border-line px-2 py-2 font-mono text-[11px]">
          {treeQuery.isLoading && <div className="text-ink-dim">loading…</div>}
          {treeQuery.isError && <div className="text-red">{treeQuery.error.message}</div>}
          {treeQuery.data && (
            <FileTree
              nodes={treeQuery.data}
              selected={selected}
              onSelect={onSelectFile}
              depth={0}
            />
          )}
          {treeQuery.data && flattenFiles(treeQuery.data).length === 0 && (
            <div className="text-ink-dim">empty def dir</div>
          )}
        </nav>

        {/* Editor / form */}
        <div className="flex min-w-0 flex-1 flex-col">
          {showFormToggle && (
            <div className="flex items-center gap-1 border-b border-line px-2 py-1">
              <ViewChip
                active={viewMode === 'form'}
                label={isManifestPath(editPath, selected) ? 'Manifest' : 'Agent'}
                onClick={() => {
                  // Switching to form re-parses current text
                  setViewMode('form')
                }}
              />
              <ViewChip
                active={viewMode === 'raw'}
                label="Raw"
                onClick={() => setViewMode('raw')}
              />
            </div>
          )}

          {loadError ? (
            <div className="px-3 py-2 font-mono text-xs text-red">
              load error: {loadError} — editing disabled for this file.
            </div>
          ) : textLoading ? (
            <div className="px-3 py-2 font-mono text-xs text-ink-dim">loading…</div>
          ) : viewMode === 'raw' || !showFormToggle ? (
            <FileEditor
              key={`${selected}:${String(textEpoch)}:raw`}
              path={selected}
              text={fileText}
              onTextChange={(t) => {
                setFileText(t)
                setDirty(true)
              }}
              onSaved={(t) => {
                setFileText(t)
                setDirty(false)
                void queryClient.invalidateQueries({
                  queryKey: ['workflow', baseUrl, workflowId],
                })
              }}
              onDirtyChange={setDirty}
              className="min-h-0 flex-1"
              minHeight="18rem"
            />
          ) : isManifestPath(editPath, selected) ? (
            <ManifestFormOverlay
              key={`${selected}:${String(textEpoch)}:form`}
              text={fileText}
              dirty={dirty}
              onChangeText={(t) => {
                setFileText(t)
                setDirty(true)
              }}
              onSave={() => void saveText(fileText)}
            />
          ) : (
            <AgentCardOverlay
              key={`${selected}:${String(textEpoch)}:form`}
              text={fileText}
              fileName={baseName(selected)}
              dirty={dirty}
              onChangeText={(t) => {
                setFileText(t)
                setDirty(true)
              }}
              onSave={() => void saveText(fileText)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ViewChip(props: { active: boolean; label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={`rounded px-2 py-0.5 font-mono text-[11px] ${
        props.active ? 'bg-panel-2 text-em' : 'text-ink-dim hover:text-ink'
      }`}
    >
      {props.label}
    </button>
  )
}

function FileTree(props: {
  nodes: TreeNode[]
  selected: string
  onSelect: (path: string) => void
  depth: number
}): JSX.Element {
  return (
    <ul className="flex flex-col gap-0.5">
      {props.nodes.map((n) => (
        <li key={n.path}>
          {n.type === 'dir' ? (
            <div>
              <div className="truncate text-ink-dim" style={{ paddingLeft: props.depth * 10 }}>
                {n.name}/
              </div>
              {n.children && (
                <FileTree
                  nodes={n.children}
                  selected={props.selected}
                  onSelect={props.onSelect}
                  depth={props.depth + 1}
                />
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => props.onSelect(n.path)}
              className={`block w-full truncate text-left hover:text-em ${
                props.selected === n.path ? 'text-em' : 'text-ink'
              }`}
              style={{ paddingLeft: props.depth * 10 }}
            >
              {n.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Manifest form overlay — same bytes as raw view
// ---------------------------------------------------------------------------

function ManifestFormOverlay(props: {
  text: string
  dirty: boolean
  onChangeText: (t: string) => void
  onSave: () => void
}): JSX.Element {
  // Parse once on mount (parent remounts via key when file/epoch changes).
  // Do NOT re-parse on every props.text change — that would reset while typing.
  const initial = useMemo(() => {
    try {
      return {
        form: manifestFormFromRaw(parseYaml(props.text)),
        error: undefined as string | undefined,
      }
    } catch (err) {
      return {
        form: emptyManifestForm(),
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [])
  const [parseError, setParseError] = useState<string | undefined>(initial.error)
  const [form, setForm] = useState<ManifestFormState>(initial.form)

  // Broken-on-disk manifest: never render editable fields over the empty
  // skeleton — one keystroke would serialize it into fileText and a save
  // would destroy the original bytes. Fixing broken YAML is Raw view's job.
  if (initial.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        <p className="mb-2 font-mono text-xs text-red">
          workflow.yaml does not parse: {initial.error}
        </p>
        <p className="font-mono text-xs text-ink-dim">
          Fix it in the Raw view — the form editor is disabled until the file parses.
        </p>
      </div>
    )
  }

  const push = (next: ManifestFormState): void => {
    setForm(next)
    try {
      const raw = rawFromManifestForm(next)
      props.onChangeText(stringifyYaml(raw))
      setParseError(undefined)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err))
    }
  }

  const updateField = (
    list: 'input' | 'output',
    index: number,
    patch: Partial<WorkflowField>,
  ): void => {
    const arr = [...form[list]]
    arr[index] = { ...arr[index], ...patch }
    push({ ...form, [list]: arr })
  }

  const addField = (list: 'input' | 'output'): void => {
    push({
      ...form,
      [list]: [...form[list], { name: 'field', type: 'string' as const, required: true }],
    })
  }

  const removeField = (list: 'input' | 'output', index: number): void => {
    push({ ...form, [list]: form[list].filter((_, i) => i !== index) })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-xs text-ink-dim">manifest form</span>
        {props.dirty && <span className="font-mono text-[11px] text-ink-dim">• modified</span>}
        <button
          type="button"
          onClick={props.onSave}
          className="ml-auto rounded border border-line px-2 py-0.5 font-mono text-[11px] hover:border-em"
        >
          Save
        </button>
      </div>
      {parseError && <p className="mb-2 font-mono text-xs text-red">parse error: {parseError}</p>}
      <div className="grid max-w-xl gap-3">
        <Field label="id">
          <input
            className="w-full rounded border border-line bg-panel-2 px-2 py-1 font-mono text-sm"
            value={form.id}
            onChange={(e) => push({ ...form, id: e.target.value })}
          />
        </Field>
        <Field label="name">
          <input
            className="w-full rounded border border-line bg-panel-2 px-2 py-1 text-sm"
            value={form.name}
            onChange={(e) => push({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="version">
          <input
            className="w-full rounded border border-line bg-panel-2 px-2 py-1 font-mono text-sm"
            value={form.version}
            onChange={(e) => push({ ...form, version: e.target.value })}
          />
        </Field>
        <Field label="description">
          <textarea
            className="w-full rounded border border-line bg-panel-2 px-2 py-1 text-sm"
            rows={2}
            value={form.description}
            onChange={(e) => push({ ...form, description: e.target.value })}
          />
        </Field>

        <FieldTable
          title="input"
          fields={form.input}
          onChange={(i, p) => updateField('input', i, p)}
          onAdd={() => addField('input')}
          onRemove={(i) => removeField('input', i)}
        />
        <FieldTable
          title="output"
          fields={form.output}
          onChange={(i, p) => updateField('output', i, p)}
          onAdd={() => addField('output')}
          onRemove={(i) => removeField('output', i)}
        />

        <div>
          <h3 className="mb-1 font-mono text-[11px] uppercase text-ink-dim">budgets</h3>
          <div className="grid grid-cols-3 gap-2">
            <NumField
              label="maxTokens"
              value={form.budgets.maxTokens}
              onChange={(v) => push({ ...form, budgets: { ...form.budgets, maxTokens: v } })}
            />
            <NumField
              label="maxCost"
              value={form.budgets.maxCost}
              onChange={(v) => push({ ...form, budgets: { ...form.budgets, maxCost: v } })}
            />
            <NumField
              label="maxConcurrentRuns"
              value={form.budgets.maxConcurrentRuns}
              onChange={(v) =>
                push({ ...form, budgets: { ...form.budgets, maxConcurrentRuns: v } })
              }
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function Field(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="mb-0.5 block font-mono text-[11px] text-ink-dim">{props.label}</span>
      {props.children}
    </label>
  )
}

function NumField(props: {
  label: string
  value?: number
  onChange: (v: number | undefined) => void
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-0.5 block font-mono text-[10px] text-ink-dim">{props.label}</span>
      <input
        type="number"
        className="w-full rounded border border-line bg-panel-2 px-2 py-1 font-mono text-xs"
        value={props.value ?? ''}
        onChange={(e) => {
          const t = e.target.value
          props.onChange(t === '' ? undefined : Number(t))
        }}
      />
    </label>
  )
}

function FieldTable(props: {
  title: string
  fields: WorkflowField[]
  onChange: (index: number, patch: Partial<WorkflowField>) => void
  onAdd: () => void
  onRemove: (index: number) => void
}): JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-mono text-[11px] uppercase text-ink-dim">{props.title}</h3>
        <button
          type="button"
          onClick={props.onAdd}
          className="font-mono text-[10px] text-em hover:underline"
        >
          + add
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {props.fields.map((f, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_4rem_1fr_auto] items-center gap-1">
            <input
              className="rounded border border-line bg-panel-2 px-1 py-0.5 font-mono text-xs"
              value={f.name}
              onChange={(e) => props.onChange(i, { name: e.target.value })}
              placeholder="name"
            />
            <select
              className="rounded border border-line bg-panel-2 px-1 py-0.5 font-mono text-xs"
              value={f.type}
              onChange={(e) => props.onChange(i, { type: e.target.value as WorkflowField['type'] })}
            >
              {['string', 'number', 'boolean', 'json', 'file'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 font-mono text-[10px] text-ink-dim">
              <input
                type="checkbox"
                checked={f.required !== false}
                onChange={(e) => props.onChange(i, { required: e.target.checked })}
              />
              req
            </label>
            <input
              className="rounded border border-line bg-panel-2 px-1 py-0.5 text-xs"
              value={f.description ?? ''}
              onChange={(e) => props.onChange(i, { description: e.target.value || undefined })}
              placeholder="description"
            />
            <button
              type="button"
              onClick={() => props.onRemove(i)}
              className="font-mono text-[10px] text-red hover:underline"
            >
              ✕
            </button>
          </div>
        ))}
        {props.fields.length === 0 && <p className="text-xs text-ink-dim">no fields</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent card overlay
// ---------------------------------------------------------------------------

function AgentCardOverlay(props: {
  text: string
  fileName: string
  dirty: boolean
  onChangeText: (t: string) => void
  onSave: () => void
}): JSX.Element {
  // Mount-only seed; parent remounts on file switch via key.
  const initial = useMemo(() => {
    try {
      const split = splitFrontmatter(props.text)
      const fields =
        split.yaml !== null
          ? agentFieldsFromConfig(parseYaml(split.yaml))
          : ({} as AgentFrontmatterFields)
      return { fields, body: split.body, error: undefined as string | undefined }
    } catch (err) {
      return {
        fields: {},
        body: props.text,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [])
  const [parseError, setParseError] = useState<string | undefined>(initial.error)
  const [fields, setFields] = useState<AgentFrontmatterFields>(initial.fields)
  const [body, setBody] = useState(initial.body)

  // Same guard as the manifest overlay: broken frontmatter must not render
  // editable fields — a body edit would wrap the original file in an empty
  // fence pair and a field edit would absorb the old frontmatter into the
  // markdown body. Raw view owns fixing broken files.
  if (initial.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        <p className="mb-2 font-mono text-xs text-red">
          {props.fileName} frontmatter does not parse: {initial.error}
        </p>
        <p className="font-mono text-xs text-ink-dim">
          Fix it in the Raw view — the card editor is disabled until the frontmatter parses.
        </p>
      </div>
    )
  }

  const push = (nextFields: AgentFrontmatterFields, nextBody: string): void => {
    setFields(nextFields)
    setBody(nextBody)
    try {
      const cfg = configFromAgentFields(nextFields)
      const hasKeys = Object.keys(cfg).length > 0
      const yamlText = hasKeys ? stringifyYaml(cfg).replace(/\n$/, '') : ''
      const joined = hasKeys
        ? joinFrontmatter(yamlText, nextBody)
        : nextBody.startsWith('---')
          ? joinFrontmatter('', nextBody)
          : nextBody
      props.onChangeText(joined)
      setParseError(undefined)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err))
    }
  }

  const agentName = props.fileName.replace(/\.md$/, '')

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-xs text-em">{agentName}</span>
        {props.dirty && <span className="font-mono text-[11px] text-ink-dim">• modified</span>}
        <button
          type="button"
          onClick={props.onSave}
          className="ml-auto rounded border border-line px-2 py-0.5 font-mono text-[11px] hover:border-em"
        >
          Save
        </button>
      </div>
      {parseError && <p className="mb-2 font-mono text-xs text-red">parse error: {parseError}</p>}
      <div className="mb-3 grid max-w-xl grid-cols-2 gap-3">
        <Field label="model">
          <input
            className="w-full rounded border border-line bg-panel-2 px-2 py-1 font-mono text-sm"
            value={fields.model ?? ''}
            onChange={(e) => push({ ...fields, model: e.target.value || undefined }, body)}
            placeholder="(default)"
          />
        </Field>
        <Field label="maxTurns">
          <input
            type="number"
            className="w-full rounded border border-line bg-panel-2 px-2 py-1 font-mono text-sm"
            value={fields.maxTurns ?? ''}
            onChange={(e) => {
              const t = e.target.value
              push({ ...fields, maxTurns: t === '' ? undefined : Number(t) }, body)
            }}
          />
        </Field>
      </div>
      <Field label="prompt body">
        <textarea
          className="min-h-[12rem] w-full rounded border border-line bg-panel-2 px-3 py-2 font-mono text-sm leading-relaxed"
          value={body}
          onChange={(e) => push(fields, e.target.value)}
          spellCheck={false}
        />
      </Field>
    </div>
  )
}
