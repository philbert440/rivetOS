/**
 * Files — full browser over the node's files root (`/rivet-shared` default).
 * List/navigate, multi-select, preview, mkdir/rename/delete, drag-and-drop
 * upload into the current dir, and drag rows onto folders to move.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker, useNavigate, useSearch } from '@tanstack/react-router'
import type { FileEntry } from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { Select } from '../components/select.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import { rivetShell } from '../lib/shell-bridge.js'
import {
  guardClosePreview,
  guardOpenFile,
  guardPathNav,
  discardMessage,
  DISCARD_CONFIRM_OPTS,
} from '../lib/files-dirty-guard.js'
import {
  baseName,
  downloadTooLargeError,
  joinRel,
  parentRel,
  previewKind,
  readBlobBounded,
} from '../lib/files-ui.js'
import { useGateway } from '../lib/use-gateway.js'
import { useUiInteraction } from '../stores/ui-interaction.js'
import { useConfirmDialog } from '../components/confirm-dialog.js'
import { saveViaGateway } from './files/save-via-gateway.js'
import { PreviewPane } from './files/preview-pane.js'
import { FileTable } from './files/file-table.js'
import type { Notice } from './files/notice.js'
import { FileEditor } from '../components/file-editor.js'

type SortKey = 'name' | 'mtime' | 'size'

export function FilesPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const connected = useGatewayReady()
  const gateway = useGateway()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // The current directory lives in ?path= so a location survives refresh and
  // is shareable; navigation pushes history (back = up a directory).
  const { path: pathFromUrl } = useSearch({ from: '/files' })
  const path = pathFromUrl ?? ''
  const setPath = useCallback(
    (next: string): void => {
      void navigate({ to: '/files', search: next ? { path: next } : {} })
    },
    [navigate],
  )
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortKey>('name')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [previewPath, setPreviewPath] = useState<string | undefined>()
  const discardDialog = useConfirmDialog()
  const discardConfirm = discardDialog.confirm
  const filesDirty = useUiInteraction((s) => s.filesDirty)
  const { setFilesDirty, promptFilesDirty, answerFilesDirty, clearFilesDirty } =
    useUiInteraction.getState()
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<Notice | undefined>()
  const [busy, setBusy] = useState(false)
  const dialog = useConfirmDialog()
  const dragDepth = useRef(0)
  /** Ignore openRaw briefly after a dir navigate so a folder double-click
   *  does not act on whatever row lands under the pointer in the child listing. */
  const suppressRawUntilRef = useRef(0)

  const listing = useQuery({
    queryKey: ['files', baseUrl, path],
    queryFn: ({ signal }) => useConnection.getState().gateway.filesList(path, signal),
    enabled: connected,
  })

  const setEditorDirtyTracked = useCallback(
    (dirty: boolean) => setFilesDirty(dirty),
    [setFilesDirty],
  )

  const clearDirty = useCallback(() => {
    clearFilesDirty()
  }, [clearFilesDirty])

  const dirtyFileName = previewPath ? baseName(previewPath) : undefined

  const shouldBlockFn = useCallback(async () => {
    const dirty = filesDirty.dirty
    promptFilesDirty('leave the page')
    const ok = dirty
      ? await discardConfirm(discardMessage(filesDirty.fileName || undefined), {
          ...DISCARD_CONFIRM_OPTS,
        })
      : true
    answerFilesDirty(ok)
    if (ok) clearDirty()
    return ok
  }, [
    answerFilesDirty,
    clearDirty,
    discardConfirm,
    filesDirty.dirty,
    filesDirty.fileName,
    promptFilesDirty,
  ])
  const enableBeforeUnload = useCallback(() => filesDirty.dirty, [filesDirty.dirty])

  // Route changes (sidebar leave, ?path= crumbs, browser Back/Forward) go
  // through the router blocker so Cancel never leaves a foreign listing under
  // an open pane. enableBeforeUnload covers tab close / reload in a browser;
  // the Electron shell still needs will-prevent-unload (see rivethub-electron)
  // because a cancelled beforeunload there silently aborts Quit/close.
  useBlocker({ shouldBlockFn, enableBeforeUnload })

  // Path landed (blocker already resolved any dirty prompt). Drop selection
  // and close the preview — no after-the-fact confirm.
  useEffect(() => {
    setSelected(new Set())
    setPreviewPath(undefined)
  }, [path])

  const markDirNavigated = useCallback((): void => {
    suppressRawUntilRef.current = performance.now() + 500
  }, [])

  const navigateGuarded = useCallback(
    (next: string): void => {
      // Same-path must no-op BEFORE any confirm: an accepted discard that
      // then setPaths to the current value would clear dirty while the pane
      // stays open and leave later closes unguarded.
      if (guardPathNav(path, next) === 'noop') return
      markDirNavigated()
      setPath(next)
    },
    [markDirNavigated, path, setPath],
  )

  useEffect(() => {
    setEditorDirtyTracked(false)
  }, [previewPath, setEditorDirtyTracked])

  const openEntry = useCallback(
    async (child: string, isDir: boolean): Promise<void> => {
      if (isDir) {
        if (guardPathNav(path, child) === 'noop') return
        markDirNavigated()
        setPath(child)
        return
      }
      const decision = await guardOpenFile({
        dirty: filesDirty.dirty,
        previewPath,
        child,
        fileName: dirtyFileName,
        confirm: discardConfirm,
        clearDirty,
      })
      if (decision !== 'proceed') return
      setPreviewPath(child)
    },
    [clearDirty, dirtyFileName, discardConfirm, markDirNavigated, path, previewPath, setPath],
  )

  const openRaw = useCallback(
    (entry: FileEntry, child: string): void => {
      if (entry.type !== 'file') return
      // Raw tab / download does not replace the preview buffer — no dirty gate.
      const url = gateway.fileDownloadUrl(child)
      if (rivetShell()) {
        if (previewKind(entry.name, entry.size) !== 'none') void openEntry(child, false)
        else
          void saveViaGateway(url, entry.name, entry.size)
            .then(() => {
              showNotice({ kind: 'ok', text: `download started: ${entry.name}` })
            })
            .catch((err: unknown) => {
              showNotice({ kind: 'err', text: (err as Error).message })
            })
      } else {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    },
    [gateway, openEntry],
  )

  const refresh = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['files', baseUrl, path] })
  }, [queryClient, baseUrl, path])

  const showNotice = (n: Notice): void => setNotice(n)

  const entries = useMemo(() => {
    const raw = listing.data?.entries ?? []
    const q = filter.trim().toLowerCase()
    const list = q ? raw.filter((e) => e.name.toLowerCase().includes(q)) : [...raw]
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'size') return a.size - b.size || a.name.localeCompare(b.name)
      return b.mtime - a.mtime || a.name.localeCompare(b.name)
    })
    return list
  }, [listing.data?.entries, filter, sort])

  if (!connected) return <NotConnected />

  const upload = async (files: FileList | File[]): Promise<void> => {
    await uploadInto(path, files)
  }

  const uploadInto = async (dirPath: string, files: FileList | File[]): Promise<void> => {
    setBusy(true)
    let ok = 0
    const errors: string[] = []
    for (const file of Array.from(files)) {
      try {
        await gateway.filesUpload(dirPath, file.name, file)
        ok += 1
      } catch (err) {
        if (err instanceof GatewayError && err.status === 409) {
          if (await dialog.confirm(`${file.name} already exists — overwrite?`)) {
            try {
              await gateway.filesUpload(dirPath, file.name, file, { overwrite: true })
              ok += 1
              continue
            } catch (err2) {
              errors.push(`${file.name}: ${(err2 as Error).message}`)
              continue
            }
          }
          continue
        }
        errors.push(`${file.name}: ${(err as Error).message}`)
      }
    }
    await refresh()
    setBusy(false)
    showNotice(
      errors.length > 0
        ? { kind: 'err', text: errors.join(' · ') }
        : {
            kind: 'ok',
            text:
              dirPath === path
                ? `uploaded ${String(ok)} file${ok === 1 ? '' : 's'}`
                : `uploaded ${String(ok)} into ${dirPath.split('/').pop() ?? dirPath}/`,
          },
    )
  }

  const mkdir = async (): Promise<void> => {
    const name = await dialog.prompt('New folder name')
    if (!name?.trim()) return
    setBusy(true)
    try {
      await gateway.filesMkdir(path, name.trim())
      await refresh()
      showNotice({ kind: 'ok', text: `created ${name.trim()}/` })
    } catch (err) {
      showNotice({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const renameOne = async (entry: FileEntry): Promise<void> => {
    const next = await dialog.prompt('Rename to', { defaultValue: entry.name })
    if (!next?.trim() || next.trim() === entry.name) return
    const from = joinRel(path, entry.name)
    const to = joinRel(path, next.trim())
    setBusy(true)
    try {
      await gateway.filesRename(from, to)
      setSelected((s) => {
        const n = new Set(s)
        n.delete(entry.name)
        return n
      })
      if (previewPath === from) setPreviewPath(to)
      await refresh()
      showNotice({ kind: 'ok', text: `renamed → ${next.trim()}` })
    } catch (err) {
      showNotice({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    const names = [...selected]
    if (names.length === 0) return
    if (!(await dialog.confirm(`Delete ${String(names.length)} item(s)?`, { danger: true }))) return
    setBusy(true)
    const errors: string[] = []
    for (const name of names) {
      const rel = joinRel(path, name)
      const entry = (listing.data?.entries ?? []).find((e) => e.name === name)
      try {
        await gateway.filesDelete(rel)
      } catch (err) {
        if (
          err instanceof GatewayError &&
          err.status === 409 &&
          entry?.type === 'dir' &&
          (await dialog.confirm(`${name}/ is not empty — delete recursively?`, { danger: true }))
        ) {
          try {
            await gateway.filesDelete(rel, { recursive: true })
            continue
          } catch (err2) {
            errors.push(`${name}: ${(err2 as Error).message}`)
            continue
          }
        }
        errors.push(`${name}: ${(err as Error).message}`)
      }
    }
    setSelected(new Set())
    if (
      previewPath &&
      names.some(
        (n) => previewPath === joinRel(path, n) || previewPath.startsWith(joinRel(path, n) + '/'),
      )
    ) {
      setPreviewPath(undefined)
    }
    await refresh()
    setBusy(false)
    showNotice(
      errors.length > 0
        ? { kind: 'err', text: errors.join(' · ') }
        : { kind: 'ok', text: `deleted ${String(names.length - errors.length)}` },
    )
  }

  const moveOntoDir = async (srcName: string, destDirName: string): Promise<void> => {
    if (srcName === destDirName) return
    const from = joinRel(path, srcName)
    const to = joinRel(joinRel(path, destDirName), srcName)
    setBusy(true)
    try {
      await gateway.filesRename(from, to)
      setSelected(new Set())
      await refresh()
      showNotice({ kind: 'ok', text: `moved ${srcName} → ${destDirName}/` })
    } catch (err) {
      showNotice({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const copyPaths = async (): Promise<void> => {
    const lines = [...selected].map((n) => joinRel(path, n))
    if (lines.length === 0) return
    try {
      await copyTextToClipboard(lines.join('\n'))
      showNotice({ kind: 'ok', text: 'path(s) copied' })
    } catch {
      showNotice({ kind: 'err', text: 'copy failed' })
    }
  }

  const copyUrls = async (): Promise<void> => {
    const gw = gateway
    const lines = [...selected]
      .map((n) => {
        const e = (listing.data?.entries ?? []).find((x) => x.name === n)
        if (!e || e.type !== 'file') return null
        return gw.fileDownloadUrl(joinRel(path, n))
      })
      .filter((x): x is string => !!x)
    if (lines.length === 0) {
      showNotice({ kind: 'err', text: 'select file(s) to copy download URLs' })
      return
    }
    try {
      await copyTextToClipboard(lines.join('\n'))
      showNotice({ kind: 'ok', text: 'URL(s) copied' })
    } catch {
      showNotice({ kind: 'err', text: 'copy failed' })
    }
  }

  const crumbs = path === '' ? [] : path.split('/')
  const rootLabel = listing.data?.root ?? '/rivet-shared'
  const allNames = entries.map((e) => e.name)
  const allSelected = allNames.length > 0 && allNames.every((n) => selected.has(n))

  const onDropFiles = (e: DragEvent): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    // Internal move uses application/x-rivet-file; OS files use dataTransfer.files
    const internal = e.dataTransfer.getData('application/x-rivet-file')
    if (internal) return // handled on folder row
    if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files)
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={(e) => {
        e.preventDefault()
        if ([...e.dataTransfer.types].includes('Files')) {
          dragDepth.current += 1
          setDragging(true)
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropFiles}
    >
      {dialog.element}
      {discardDialog.element}
      {/* Breadcrumbs */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel/40 px-4 py-2 text-xs">
        <button
          type="button"
          onClick={() => navigateGuarded('')}
          className={crumbs.length === 0 ? 'text-em' : 'text-ink-dim hover:text-ink'}
        >
          {rootLabel}
        </button>
        {crumbs.map((seg, i) => (
          <span key={crumbs.slice(0, i + 1).join('/')} className="flex items-center gap-1">
            <span className="text-ink-dim">/</span>
            <button
              type="button"
              onClick={() => navigateGuarded(crumbs.slice(0, i + 1).join('/'))}
              className={i === crumbs.length - 1 ? 'text-em' : 'text-ink-dim hover:text-ink'}
            >
              {seg}
            </button>
          </span>
        ))}
        <span className="ml-auto text-ink-dim">
          drop files to upload · drag onto a folder to move
        </span>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-40 rounded-lg border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-em"
        />
        <Select
          value={sort}
          title="sort"
          label="Sort"
          onChange={(v) => setSort(v as SortKey)}
          options={[
            { value: 'name', label: 'sort: name' },
            { value: 'mtime', label: 'sort: mtime' },
            { value: 'size', label: 'sort: size' },
          ]}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void mkdir()}
          className="rounded-pill border border-line px-2 py-1 text-xs hover:bg-ink/6 disabled:opacity-40 classic:hover:bg-transparent classic:hover:border-em"
        >
          New folder
        </button>
        <button
          type="button"
          disabled={busy || selected.size !== 1}
          onClick={() => {
            const name = [...selected][0]
            const entry = (listing.data?.entries ?? []).find((e) => e.name === name)
            if (entry) void renameOne(entry)
          }}
          className="rounded-pill border border-line px-2 py-1 text-xs hover:bg-ink/6 disabled:opacity-40 classic:hover:bg-transparent classic:hover:border-em"
        >
          Rename
        </button>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => void deleteSelected()}
          className="rounded-pill border border-red/40 px-2 py-1 text-xs text-red hover:bg-red/10 disabled:opacity-40 classic:hover:bg-transparent classic:hover:border-red"
        >
          Delete
        </button>
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={() => void copyPaths()}
          className="rounded-pill border border-line px-2 py-1 text-xs hover:bg-ink/6 disabled:opacity-40 classic:hover:bg-transparent classic:hover:border-em"
        >
          Copy path
        </button>
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={() => void copyUrls()}
          className="rounded-pill border border-line px-2 py-1 text-xs hover:bg-ink/6 disabled:opacity-40 classic:hover:bg-transparent classic:hover:border-em"
        >
          Copy URL
        </button>
        <label className="cursor-pointer rounded-pill border border-line px-2 py-1 text-xs hover:bg-ink/6 classic:hover:bg-transparent classic:hover:border-em">
          Upload…
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void upload(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
      </div>

      {notice && (
        <div
          className={`border-b border-line px-4 py-1.5 text-xs ${notice.kind === 'ok' ? 'text-em' : 'text-red'}`}
        >
          {notice.text}
          <button
            type="button"
            onClick={() => setNotice(undefined)}
            className="ml-3 text-ink-dim hover:text-ink"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <FileTable
          path={path}
          entries={entries}
          loading={listing.isLoading}
          error={listing.isError ? listing.error : undefined}
          filterActive={filter.trim() !== ''}
          selected={selected}
          onToggleSelectAll={(names) => setSelected(names)}
          onToggleSelect={(name) => {
            setSelected((prev) => {
              const n = new Set(prev)
              if (n.has(name)) n.delete(name)
              else n.add(name)
              return n
            })
          }}
          onOpenEntry={(child, isDir) => void openEntry(child, isDir)}
          onOpenRaw={openRaw}
          onMoveOntoDir={(src, dest) => void moveOntoDir(src, dest)}
          onDropFilesInto={(dir, files) => void uploadInto(dir, files)}
          onNavigateUp={() => navigateGuarded(parentRel(path))}
          suppressRawUntil={suppressRawUntilRef}
        />

        {/* Preview / edit pane — text files use the shared CodeMirror editor */}
        {previewPath && (
          <PreviewPane
            path={previewPath}
            onClose={() => {
              void (async () => {
                const decision = await guardClosePreview({
                  dirty: filesDirty.dirty,
                  fileName: dirtyFileName,
                  confirm: discardConfirm,
                  clearDirty,
                })
                if (decision !== 'proceed') return
                setPreviewPath(undefined)
              })()
            }}
            onNotice={showNotice}
            onDirtyChange={setEditorDirtyTracked}
            downloadUrl={gateway.fileDownloadUrl(previewPath)}
            size={
              (listing.data?.entries ?? []).find((e) => joinRel(path, e.name) === previewPath)?.size
            }
          />
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-em bg-panel/80">
          <span className="text-sm text-em">
            drop to upload into /{path === '' ? '' : `${path}/`}
          </span>
        </div>
      )}
    </div>
  )
}
