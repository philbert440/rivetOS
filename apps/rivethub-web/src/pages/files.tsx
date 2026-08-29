/**
 * Files — full browser over the node's files root (`/rivet-shared` default).
 * List/navigate, multi-select, preview, mkdir/rename/delete, drag-and-drop
 * upload into the current dir, and drag rows onto folders to move.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { FileEntry } from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'
import { Select } from '../components/select.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import { openExternal } from '../lib/open-external.js'
import { baseName, joinRel, parentRel, previewKind } from '../lib/files-ui.js'
import { useGateway } from '../lib/use-gateway.js'
import { useConfirmDialog } from '../components/confirm-dialog.js'
import { FileEditor } from '../components/file-editor.js'

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtMtime(ms: number): string {
  const d = new Date(ms)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

type SortKey = 'name' | 'mtime' | 'size'
type Notice = { kind: 'ok' | 'err'; text: string }

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
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<Notice | undefined>()
  const [busy, setBusy] = useState(false)
  const dialog = useConfirmDialog()
  const dragDepth = useRef(0)

  const listing = useQuery({
    queryKey: ['files', baseUrl, path],
    queryFn: ({ signal }) => useConnection.getState().gateway.filesList(path, signal),
    enabled: connected,
  })

  // Clear selection when navigating
  useEffect(() => {
    setSelected(new Set())
    setPreviewPath(undefined)
  }, [path])

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
    setBusy(true)
    let ok = 0
    const errors: string[] = []
    for (const file of Array.from(files)) {
      try {
        await gateway.filesUpload(path, file.name, file)
        ok += 1
      } catch (err) {
        if (err instanceof GatewayError && err.status === 409) {
          if (await dialog.confirm(`${file.name} already exists — overwrite?`)) {
            try {
              await gateway.filesUpload(path, file.name, file, { overwrite: true })
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
        : { kind: 'ok', text: `uploaded ${String(ok)} file${ok === 1 ? '' : 's'}` },
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
      {/* Breadcrumbs */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel/40 px-4 py-2 font-mono text-xs">
        <button
          type="button"
          onClick={() => setPath('')}
          className={crumbs.length === 0 ? 'text-em' : 'text-ink-dim hover:text-ink'}
        >
          {rootLabel}
        </button>
        {crumbs.map((seg, i) => (
          <span key={crumbs.slice(0, i + 1).join('/')} className="flex items-center gap-1">
            <span className="text-ink-dim">/</span>
            <button
              type="button"
              onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
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
          className="w-40 rounded border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-em"
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
          className="rounded border border-line px-2 py-1 text-xs hover:border-em disabled:opacity-40"
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
          className="rounded border border-line px-2 py-1 text-xs hover:border-em disabled:opacity-40"
        >
          Rename
        </button>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => void deleteSelected()}
          className="rounded border border-red/40 px-2 py-1 text-xs text-red hover:border-red disabled:opacity-40"
        >
          Delete
        </button>
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={() => void copyPaths()}
          className="rounded border border-line px-2 py-1 text-xs hover:border-em disabled:opacity-40"
        >
          Copy path
        </button>
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={() => void copyUrls()}
          className="rounded border border-line px-2 py-1 text-xs hover:border-em disabled:opacity-40"
        >
          Copy URL
        </button>
        <label className="cursor-pointer rounded border border-line px-2 py-1 text-xs hover:border-em">
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
          className={`border-b border-line px-4 py-1.5 font-mono text-xs ${notice.kind === 'ok' ? 'text-em' : 'text-red'}`}
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
        {/* Listing */}
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-2">
          {listing.isError ? (
            <div className="py-6 font-mono text-sm text-red">{listing.error.message}</div>
          ) : entries.length === 0 && !listing.isLoading ? (
            <div className="py-6 text-sm text-ink-dim">
              {filter ? 'No matches.' : 'Empty directory — drop files here or use Upload.'}
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[10px] text-ink-dim">
                  <th className="w-8 py-1 pr-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => {
                        setSelected(allSelected ? new Set() : new Set(allNames))
                      }}
                      aria-label="select all"
                    />
                  </th>
                  <th className="py-1">name</th>
                  <th className="w-24 py-1 text-right">size</th>
                  <th className="w-36 py-1 text-right">modified</th>
                </tr>
              </thead>
              <tbody>
                {path !== '' && (
                  <tr className="border-b border-line/40">
                    <td />
                    <td colSpan={3} className="py-1">
                      <button
                        type="button"
                        onClick={() => setPath(parentRel(path))}
                        className="font-mono text-ink-dim hover:text-ink"
                      >
                        ../
                      </button>
                    </td>
                  </tr>
                )}
                {entries.map((e) => {
                  const child = joinRel(path, e.name)
                  const isSel = selected.has(e.name)
                  return (
                    <tr
                      key={e.name}
                      className={`border-b border-line/40 hover:bg-panel-2/50 ${isSel ? 'bg-panel-2/40' : ''}`}
                      draggable
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData('application/x-rivet-file', e.name)
                        ev.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragOver={
                        e.type === 'dir'
                          ? (ev) => {
                              ev.preventDefault()
                              ev.dataTransfer.dropEffect = 'move'
                            }
                          : undefined
                      }
                      onDrop={
                        e.type === 'dir'
                          ? (ev) => {
                              ev.preventDefault()
                              ev.stopPropagation()
                              const src = ev.dataTransfer.getData('application/x-rivet-file')
                              if (src) void moveOntoDir(src, e.name)
                              else if (ev.dataTransfer.files.length > 0) {
                                // Drop OS files into this subdirectory via upload-to-path
                                const dir = child
                                void (async () => {
                                  setBusy(true)
                                  let ok = 0
                                  for (const file of Array.from(ev.dataTransfer.files)) {
                                    try {
                                      await gateway.filesUpload(dir, file.name, file)
                                      ok += 1
                                    } catch (err) {
                                      showNotice({ kind: 'err', text: (err as Error).message })
                                    }
                                  }
                                  await refresh()
                                  setBusy(false)
                                  if (ok)
                                    showNotice({
                                      kind: 'ok',
                                      text: `uploaded ${String(ok)} into ${e.name}/`,
                                    })
                                })()
                              }
                            }
                          : undefined
                      }
                    >
                      <td className="py-1.5 pr-2">
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => {
                            setSelected((prev) => {
                              const n = new Set(prev)
                              if (n.has(e.name)) n.delete(e.name)
                              else n.add(e.name)
                              return n
                            })
                          }}
                          aria-label={`select ${e.name}`}
                        />
                      </td>
                      <td className="py-1.5 pr-4">
                        <button
                          type="button"
                          onClick={() => {
                            if (e.type === 'dir') setPath(child)
                            else setPreviewPath(child)
                          }}
                          onDoubleClick={() => {
                            // openExternal, not window.open — the desktop
                            // shell denies window.open, making this a dead
                            // click there.
                            if (e.type === 'file') openExternal(gateway.fileDownloadUrl(child))
                          }}
                          className="flex items-center gap-2 text-left"
                        >
                          <span className="w-4 text-center font-mono text-ink-dim">
                            {e.type === 'dir' ? '▸' : '·'}
                          </span>
                          <span className={e.type === 'dir' ? 'text-em' : 'text-ink'}>
                            {e.name}
                            {e.type === 'dir' ? '/' : ''}
                          </span>
                        </button>
                      </td>
                      <td className="w-24 py-1.5 pr-4 text-right font-mono text-xs text-ink-dim">
                        {e.type === 'file' ? fmtSize(e.size) : ''}
                      </td>
                      <td className="w-36 py-1.5 text-right font-mono text-xs text-ink-dim">
                        {fmtMtime(e.mtime)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Preview / edit pane — text files use the shared CodeMirror editor */}
        {previewPath && (
          <PreviewPane
            path={previewPath}
            onClose={() => setPreviewPath(undefined)}
            downloadUrl={gateway.fileDownloadUrl(previewPath)}
            size={
              (listing.data?.entries ?? []).find((e) => joinRel(path, e.name) === previewPath)?.size
            }
          />
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-em bg-panel/80">
          <span className="font-mono text-sm text-em">
            drop to upload into /{path === '' ? '' : `${path}/`}
          </span>
        </div>
      )}
    </div>
  )
}

function PreviewPane(props: {
  path: string
  downloadUrl: string
  onClose: () => void
  /** Optional size from the listing — drives previewKind / edit eligibility. */
  size?: number
}): JSX.Element {
  const name = baseName(props.path)
  // Prefer known size; when unknown assume under text cap for extension classification.
  const kind = previewKind(name, props.size ?? 100_000)

  return (
    <aside className="flex w-[min(36rem,50%)] shrink-0 flex-col border-l border-line bg-panel/60">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-em">{props.path}</span>
        <a
          href={props.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(ev) => {
            // Shell denies target=_blank; browsers keep the anchor semantics
            // via openExternal's window.open fallback.
            ev.preventDefault()
            openExternal(props.downloadUrl)
          }}
          className="font-mono text-[11px] text-ink-dim hover:text-em"
        >
          open
        </a>
        <button type="button" onClick={props.onClose} className="text-ink-dim hover:text-ink">
          ✕
        </button>
      </div>
      {kind === 'image' ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <img
            src={props.downloadUrl}
            alt={name}
            className="max-w-full rounded border border-line"
          />
        </div>
      ) : kind === 'text' ? (
        <FileEditor
          key={props.path}
          path={props.path}
          size={props.size}
          className="min-h-0 flex-1"
          minHeight="12rem"
        />
      ) : (
        <div className="p-3 font-mono text-xs text-ink-dim">
          No in-app preview for this type — use download / open.
        </div>
      )}
    </aside>
  )
}
