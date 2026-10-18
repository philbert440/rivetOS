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
import { useFileOps } from './files/use-file-ops.js'
import { FilesToolbar } from './files/files-toolbar.js'
import { Breadcrumbs } from './files/breadcrumbs.js'
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
              ops.showNotice({ kind: 'ok', text: `download started: ${entry.name}` })
            })
            .catch((err: unknown) => {
              ops.showNotice({ kind: 'err', text: (err as Error).message })
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

  const ops = useFileOps({
    path,
    refresh: () => refresh(),
    confirm: dialog.confirm,
    prompt: dialog.prompt,
    onPreviewRenamed: (from, to) => {
      if (previewPath === from) setPreviewPath(to)
    },
    onPreviewDeleted: (deletedPaths) => {
      setSelected(new Set())
      if (
        previewPath &&
        deletedPaths.some((d) => previewPath === d || previewPath.startsWith(d + '/'))
      ) {
        setPreviewPath(undefined)
      }
    },
  })

  const {
    busy,
    notice,
    setNotice,
    upload,
    mkdir,
    renameOne,
    deleteSelected,
    moveOntoDir,
    copyPaths,
    copyUrls,
  } = ops

  if (!connected) return <NotConnected />

  const rootLabel = listing.data?.root ?? '/rivet-shared'

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
      <Breadcrumbs path={path} rootLabel={rootLabel} onNavigate={navigateGuarded} />

      <FilesToolbar
        filter={filter}
        onFilter={setFilter}
        sort={sort}
        onSort={(v) => setSort(v as SortKey)}
        busy={busy}
        selected={selected}
        entries={listing.data?.entries ?? []}
        notice={notice}
        onDismissNotice={() => setNotice(undefined)}
        onMkdir={() => void mkdir()}
        onRename={(entry) => void renameOne(entry)}
        onDelete={() => void deleteSelected(selected, listing.data?.entries ?? [])}
        onCopyPaths={() => void copyPaths(selected)}
        onCopyUrls={() => void copyUrls(selected, listing.data?.entries ?? [])}
        onUpload={(files) => void upload(files)}
      />

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
          onDropFilesInto={(dir, files) => void ops.uploadInto(dir, files)}
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
            onNotice={(n) => ops.showNotice(n)}
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
