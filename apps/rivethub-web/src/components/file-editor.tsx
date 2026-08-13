/**
 * Shared CodeMirror 6 file editor — one component, two mounts (Files section
 * + workflows edit mode). Loads/saves through the gateway files API
 * (download + upload?overwrite=1); no new file endpoints.
 */

import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { basicSetup } from 'codemirror'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { yaml } from '@codemirror/lang-yaml'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { GatewayError } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { languageForPath, type EditorLanguage } from '../lib/editor-lang.js'
import { baseName, previewKind } from '../lib/files-ui.js'

const TEXT_MAX = 1024 * 1024

function langExtension(lang: EditorLanguage) {
  switch (lang) {
    case 'yaml':
      return yaml()
    case 'javascript':
      return javascript()
    case 'typescript':
      return javascript({ typescript: true })
    case 'markdown':
      return markdown()
    case 'json':
      return javascript({ typescript: false })
    default:
      return []
  }
}

export interface FileEditorProps {
  /** Root-relative path under the files API. */
  path: string
  /** Optional known size (bytes) for previewKind; when omitted, assume editable until load fails. */
  size?: number
  /** Called after a successful save with the written text. */
  onSaved?: (text: string) => void
  /** When text changes (dirty tracking for parents). */
  onDirtyChange?: (dirty: boolean) => void
  /**
   * Controlled text override — when set, the editor content is driven by the
   * parent (overlay → raw round-trip). Parent must call onTextChange.
   */
  text?: string
  onTextChange?: (text: string) => void
  /** Extra chrome to the left of the save button (view toggles, etc.). */
  toolbarExtra?: ReactNode
  className?: string
  /** Min height for the editor surface. */
  minHeight?: string
  readOnly?: boolean
}

export function FileEditor(props: FileEditorProps): JSX.Element {
  const {
    path,
    size,
    onSaved,
    onDirtyChange,
    text: controlledText,
    onTextChange,
    toolbarExtra,
    className = '',
    minHeight = '16rem',
    readOnly: forceReadOnly,
  } = props

  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langComp = useRef(new Compartment())
  const themeComp = useRef(new Compartment())
  const editableComp = useRef(new Compartment())
  const savedTextRef = useRef('')
  const skipNextDocPush = useRef(false)
  const seededControlled = useRef(false)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | undefined>()
  const [saveError, setSaveError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [readOnlyReason, setReadOnlyReason] = useState<string | undefined>()

  const name = baseName(path)
  const kind =
    size !== undefined ? previewKind(name, size) : previewKind(name, Math.min(size ?? 0, TEXT_MAX))
  // When size unknown, treat text-like extensions as editable; confirm after load.
  const looksText = size === undefined ? previewKind(name, 1) === 'text' : kind === 'text'
  const readOnly = Boolean(forceReadOnly || readOnlyReason || !looksText)

  const setDirtyState = useCallback(
    (d: boolean) => {
      setDirty(d)
      onDirtyChange?.(d)
    },
    [onDirtyChange],
  )

  // Create editor once
  useEffect(() => {
    if (!hostRef.current) return
    if (viewRef.current) return

    const onUpdate = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      if (skipNextDocPush.current) {
        skipNextDocPush.current = false
        return
      }
      const next = update.state.doc.toString()
      setDirtyState(next !== savedTextRef.current)
      onTextChange?.(next)
    })

    const saveKey = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          // Save is handled via React state; dispatch a custom event the
          // outer effect listens for so we always use latest path/text.
          hostRef.current?.dispatchEvent(new CustomEvent('rivet-editor-save'))
          return true
        },
      },
    ])

    const state = EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        saveKey,
        langComp.current.of(langExtension(languageForPath(path))),
        themeComp.current.of(oneDark),
        editableComp.current.of(EditorView.editable.of(!readOnly)),
        EditorView.theme({
          '&': { height: '100%', fontSize: '12px' },
          '.cm-scroller': { fontFamily: 'var(--font-mono), ui-monospace, monospace' },
          '.cm-content': { minHeight },
        }),
        cmPlaceholder('loading…'),
        onUpdate,
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // mount once; path/theme updates apply via compartments below
  }, [])

  // Language / theme / editable compartments
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        langComp.current.reconfigure(langExtension(languageForPath(path))),
        // Dark-only app: oneDark is the single theme path.
        themeComp.current.reconfigure(oneDark),
        editableComp.current.reconfigure(EditorView.editable.of(!readOnly)),
      ],
    })
  }, [path, readOnly])

  // Load file when path changes (uncontrolled mode)
  useEffect(() => {
    if (controlledText !== undefined) {
      // Controlled: parent owns bytes; just seed the doc.
      setLoading(false)
      setLoadError(undefined)
      setReadOnlyReason(forceReadOnly ? 'read-only' : undefined)
      const view = viewRef.current
      if (view && view.state.doc.toString() !== controlledText) {
        skipNextDocPush.current = true
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: controlledText },
        })
      }
      // Seed the saved baseline only once per mount — this effect re-runs on
      // every parent-driven text change (typing), and re-baselining there
      // would reset dirty and let file switches discard edits silently.
      if (!seededControlled.current) {
        seededControlled.current = true
        savedTextRef.current = controlledText
        setDirtyState(false)
      } else {
        setDirtyState(controlledText !== savedTextRef.current)
      }
      return
    }

    let cancelled = false
    setLoading(true)
    setLoadError(undefined)
    setSaveError(undefined)
    setReadOnlyReason(undefined)
    setDirtyState(false)

    if (!looksText) {
      setLoading(false)
      setReadOnlyReason(
        kind === 'image'
          ? 'Image files open as preview only — not editable here.'
          : 'Binary or oversized file — download instead of editing.',
      )
      return
    }

    const gw = useConnection.getState().gateway
    void gw
      .filesReadText(path)
      .then((body) => {
        if (cancelled) return
        if (body.length > TEXT_MAX) {
          setReadOnlyReason('File exceeds 1 MiB text edit cap — download to edit externally.')
          setLoading(false)
          return
        }
        savedTextRef.current = body
        const view = viewRef.current
        if (view) {
          skipNextDocPush.current = true
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: body },
          })
        }
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [path, controlledText, looksText, kind, forceReadOnly, setDirtyState])

  const doSave = useCallback(async (): Promise<void> => {
    // Mirror the Save button's disabled conditions — Mod-S must never write
    // while loading or after a failed load (empty doc would clobber the file).
    if (readOnly || loading || loadError) return
    const view = viewRef.current
    const content =
      controlledText !== undefined ? controlledText : (view?.state.doc.toString() ?? '')
    setSaving(true)
    setSaveError(undefined)
    try {
      await useConnection.getState().gateway.filesSave(path, content)
      savedTextRef.current = content
      setDirtyState(false)
      onSaved?.(content)
    } catch (err) {
      if (err instanceof GatewayError) {
        if (err.status === 409) {
          setSaveError('Conflict (409): file exists and could not be overwritten.')
        } else if (err.status === 413) {
          setSaveError('File too large (413): upload rejected by size limit.')
        } else {
          setSaveError(err.message)
        }
      } else {
        setSaveError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSaving(false)
    }
  }, [path, readOnly, loading, loadError, controlledText, onSaved, setDirtyState])

  // Ctrl/Cmd+S from the keymap custom event
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const handler = (): void => {
      void doSave()
    }
    el.addEventListener('rivet-editor-save', handler)
    return () => el.removeEventListener('rivet-editor-save', handler)
  }, [doSave])

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-em" title={path}>
          {path}
          {dirty ? <span className="ml-2 text-ink-dim">• modified</span> : null}
          {readOnly ? <span className="ml-2 text-ink-dim">read-only</span> : null}
        </span>
        {toolbarExtra}
        <button
          type="button"
          disabled={readOnly || saving || loading || Boolean(loadError)}
          onClick={() => void doSave()}
          className="rounded border border-line px-2 py-0.5 font-mono text-[11px] hover:border-em disabled:opacity-40"
          title="Save (Ctrl/Cmd+S)"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {loadError && (
        <div className="border-b border-line px-3 py-1.5 font-mono text-xs text-red">
          {loadError}
        </div>
      )}
      {saveError && (
        <div className="border-b border-line px-3 py-1.5 font-mono text-xs text-red">
          {saveError}
        </div>
      )}
      {readOnlyReason && (
        <div className="border-b border-line px-3 py-1.5 font-mono text-xs text-ink-dim">
          {readOnlyReason}
        </div>
      )}
      {loading && !loadError && (
        <div className="px-3 py-2 font-mono text-xs text-ink-dim">loading…</div>
      )}
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-auto bg-panel-2/40"
        style={{ minHeight }}
      />
    </div>
  )
}
