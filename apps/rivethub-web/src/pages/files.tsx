/**
 * Files — full browser over the node's files root (`/rivet-shared` default).
 * List/navigate, multi-select, preview, mkdir/rename/delete, drag-and-drop
 * upload into the current dir, and drag rows onto folders to move.
 */

import { type DragEvent, type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker, useNavigate, useSearch } from '@tanstack/react-router'
import type { FileEntry } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { rivetShell } from '../lib/shell-bridge.js'
import {
  guardClosePreview,
  guardOpenFile,
  shouldBlockFilesLeave,
} from '../lib/files-dirty-guard.js'
import { baseName, joinRel, parentRel, previewKind } from '../lib/files-ui.js'
import { useGateway } from '../lib/use-gateway.js'
import { useUiInteraction } from '../stores/ui-interaction.js'
import { useConfirmDialog } from '../components/confirm-dialog.js'
import { saveViaGateway } from './files/save-via-gateway.js'
import { PreviewPane } from './files/preview-pane.js'
import { FileTable } from './files/file-table.js'
import { useFileOps } from './files/use-file-ops.js'
import { FilesToolbar } from './files/files-toolbar.js'
import { Breadcrumbs } from './files/breadcrumbs.js'
import { useFilesView } from './files/files-view-store.js'

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
  const filter = useFilesView((s) => s.filter)
  const sort = useFilesView((s) => s.sort)
  const selected = useFilesView((s) => s.selected)
  const previewPath = useFilesView((s) => s.previewPath)
  const { setFilter, setSort, setSelected, toggleSelected, setPreviewPath } =
    useFilesView.getState()
  // One dialog instance for the whole page. Ops confirms/prompts and the
  // dirty-guard discards share a single queue, so two modals can never be
  // open at once (these used to be two independent queues, each rendering
  // its own dialog).
  const dialog = useConfirmDialog()
  const confirm = dialog.confirm
  const filesDirty = useUiInteraction((s) => s.filesDirty)
  const { setFilesDirty } = useUiInteraction.getState()
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  /** Ignore openRaw briefly after a dir navigate so a folder double-click
   *  does not act on whatever row lands under the pointer in the child listing. */
  const suppressRawUntilRef = useRef(0)

  const listing = useQuery({
    queryKey: ['files', baseUrl, path],
    queryFn: ({ signal }) => useConnection.getState().gateway.filesList(path, signal),
    enabled: connected,
  })

  const dirtyFileName = previewPath ? baseName(previewPath) : undefined

  // Blocker callbacks must have stable identity: the router tears down and
  // re-registers the blocker when these change, and a re-register that lands
  // mid-navigation silently swallows it. Read the store imperatively at call
  // time instead of subscribing (the store is still the single source).
  const shouldBlockFn = useCallback(async () => {
    const { filesDirty } = useUiInteraction.getState()
    // useBlocker contract: return true to BLOCK. Clean → false (proceed).
    return shouldBlockFilesLeave({
      dirty: filesDirty.dirty,
      fileName: filesDirty.fileName || undefined,
      confirm,
      clearDirty: () => useUiInteraction.getState().clearFilesDirty(),
    })
  }, [confirm])

  const enableBeforeUnload = useCallback(() => useUiInteraction.getState().filesDirty.dirty, [])

  // Route changes (sidebar leave, ?path= crumbs, browser Back/Forward) go
  // through the router blocker so Cancel never leaves a foreign listing under
  // an open pane. enableBeforeUnload covers tab close / reload in a browser;
  // the Electron shell still needs will-prevent-unload (see rivethub-electron)
  // because a cancelled beforeunload there silently aborts Quit/close.
  useBlocker({ shouldBlockFn, enableBeforeUnload })

  // Path landed (blocker already resolved any dirty prompt). Drop selection
  // and close the preview — no after-the-fact confirm.
  useEffect(() => {
    useFilesView.setState({ selected: new Set<string>(), previewPath: undefined })
  }, [path])

  // The notice bar lives in a module store, so it survives unmount; clear it
  // on leave to match the old page-local state (fresh visit = no stale notice).
  useEffect(() => () => useFilesView.setState({ notice: undefined }), [])

  const markDirNavigated = useCallback((): void => {
    suppressRawUntilRef.current = performance.now() + 500
  }, [])

  const navigateGuarded = useCallback(
    (next: string): void => {
      // Same-path must no-op BEFORE any confirm: an accepted discard that
      // then setPaths to the current value would clear dirty while the pane
      // stays open and leave later closes unguarded.
      if (next === path) return
      markDirNavigated()
      setPath(next)
    },
    [markDirNavigated, path, setPath],
  )

  useEffect(() => {
    setFilesDirty(false)
  }, [previewPath, setFilesDirty])

  const openEntry = useCallback(
    async (child: string, isDir: boolean): Promise<void> => {
      if (isDir) {
        navigateGuarded(child)
        return
      }
      const storeDirty = useUiInteraction.getState().filesDirty.dirty
      const decision = await guardOpenFile({
        // Read the store at call time, not from the render closure: this
        // callback is memoized on deps that never include `dirty`, so a
        // captured value goes stale the moment you type and stays stale until
        // path/previewPath next changes.
        dirty: storeDirty,
        previewPath,
        child,
        fileName: dirtyFileName,
        confirm,
        clearDirty: () => useUiInteraction.getState().clearFilesDirty(),
      })
      if (decision !== 'proceed') return
      setPreviewPath(child)
    },
    [confirm, dirtyFileName, navigateGuarded, path, previewPath],
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

  // The toolbar's Rename target: the single selected entry, resolved here so
  // the toolbar needs neither `selected` nor `entries`. Multi-select has no
  // rename target — picking one of several would rename an arbitrary row.
  const renameTarget = useMemo(() => {
    if (selected.size !== 1) return undefined
    const [name] = [...selected]
    return (listing.data?.entries ?? []).find((e) => e.name === name)
  }, [selected, listing.data?.entries])

  const ops = useFileOps({
    path,
    refresh: () => refresh(),
    confirm,
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

  const { busy, upload, mkdir, renameOne, deleteSelected, moveOntoDir, copyPaths, copyUrls } = ops

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
      <Breadcrumbs path={path} rootLabel={rootLabel} onNavigate={navigateGuarded} />

      <FilesToolbar
        filter={filter}
        onFilter={setFilter}
        sort={sort}
        onSort={setSort}
        busy={busy}
        renameTarget={renameTarget}
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
          onToggleSelect={toggleSelected}
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
                  confirm,
                  clearDirty: () => useUiInteraction.getState().clearFilesDirty(),
                })
                if (decision !== 'proceed') return
                setPreviewPath(undefined)
              })()
            }}
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
