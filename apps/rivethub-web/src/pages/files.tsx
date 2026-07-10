/**
 * Files — drag-and-drop browser for the shared collab mount (`/rivet-shared`
 * by default; the node's den files root). List/navigate via
 * /api/files/list, click a file to open/download, drop files anywhere on
 * the page to upload into the current directory.
 */

import { useRef, useState, type DragEvent, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FileEntry } from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { NotConnected, useGatewayReady } from '../components/not-connected.js'

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

export function FilesPage(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const token = useConnection((s) => s.token)
  const connected = useGatewayReady()
  const queryClient = useQueryClient()
  const [path, setPath] = useState('')
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | undefined>()
  // dragenter/dragleave fire for every child crossed; only a zero depth is
  // a real exit from the page.
  const dragDepth = useRef(0)

  const listing = useQuery({
    queryKey: ['files', baseUrl, token ?? '', path],
    queryFn: ({ signal }) => useConnection.getState().gateway.filesList(path, signal),
    enabled: connected,
  })

  if (!connected) return <NotConnected />

  const upload = async (files: FileList): Promise<void> => {
    const gateway = useConnection.getState().gateway
    let ok = 0
    const errors: string[] = []
    for (const file of Array.from(files)) {
      try {
        await gateway.filesUpload(path, file.name, file)
        ok += 1
      } catch (err) {
        if (err instanceof GatewayError && err.status === 409) {
          // exists → ask once, then replace
          if (window.confirm(`${file.name} already exists — overwrite?`)) {
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
    await queryClient.invalidateQueries({ queryKey: ['files', baseUrl, token ?? '', path] })
    setNotice(
      errors.length > 0
        ? { kind: 'err', text: errors.join(' · ') }
        : { kind: 'ok', text: `uploaded ${String(ok)} file${ok === 1 ? '' : 's'}` },
    )
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (e.dataTransfer.files.length > 0) void upload(e.dataTransfer.files)
  }

  const crumbs = path === '' ? [] : path.split('/')
  const entries = listing.data?.entries ?? []

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1 border-b border-line bg-panel/40 px-4 py-2 font-mono text-xs">
        <button
          onClick={() => setPath('')}
          className={crumbs.length === 0 ? 'text-em' : 'text-ink-dim hover:text-ink'}
        >
          {listing.data?.root ?? '/rivet-shared'}
        </button>
        {crumbs.map((seg, i) => (
          <span key={crumbs.slice(0, i + 1).join('/')} className="flex items-center gap-1">
            <span className="text-ink-dim">/</span>
            <button
              onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
              className={i === crumbs.length - 1 ? 'text-em' : 'text-ink-dim hover:text-ink'}
            >
              {seg}
            </button>
          </span>
        ))}
        <span className="ml-auto text-ink-dim">drop files here to upload</span>
      </div>

      {notice && (
        <div
          className={`border-b border-line px-4 py-1.5 font-mono text-xs ${notice.kind === 'ok' ? 'text-em' : 'text-red'}`}
        >
          {notice.text}
          <button onClick={() => setNotice(undefined)} className="ml-3 text-ink-dim hover:text-ink">
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-2">
        {listing.isError ? (
          <div className="py-6 font-mono text-sm text-red">{listing.error.message}</div>
        ) : entries.length === 0 && !listing.isLoading ? (
          <div className="py-6 text-sm text-ink-dim">Empty directory.</div>
        ) : (
          <table className="w-full max-w-4xl border-collapse text-sm">
            <tbody>
              {path !== '' && (
                <tr>
                  <td colSpan={3} className="py-1">
                    <button
                      onClick={() => setPath(crumbs.slice(0, -1).join('/'))}
                      className="font-mono text-ink-dim hover:text-ink"
                    >
                      ../
                    </button>
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <FileRow
                  key={e.name}
                  entry={e}
                  onOpen={() => {
                    const child = path === '' ? e.name : `${path}/${e.name}`
                    if (e.type === 'dir') setPath(child)
                    else
                      window.open(
                        useConnection.getState().gateway.fileDownloadUrl(child),
                        '_blank',
                        'noopener,noreferrer',
                      )
                  }}
                />
              ))}
            </tbody>
          </table>
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

function FileRow(props: { entry: FileEntry; onOpen: () => void }): JSX.Element {
  const { entry } = props
  return (
    <tr className="border-b border-line/40 hover:bg-panel-2/50">
      <td className="py-1.5 pr-4">
        <button onClick={props.onOpen} className="flex items-center gap-2 text-left">
          <span className="w-4 text-center font-mono text-ink-dim">
            {entry.type === 'dir' ? '▸' : '·'}
          </span>
          <span className={entry.type === 'dir' ? 'text-em' : 'text-ink'}>
            {entry.name}
            {entry.type === 'dir' ? '/' : ''}
          </span>
        </button>
      </td>
      <td className="w-24 py-1.5 pr-4 text-right font-mono text-xs text-ink-dim">
        {entry.type === 'file' ? fmtSize(entry.size) : ''}
      </td>
      <td className="w-36 py-1.5 text-right font-mono text-xs text-ink-dim">
        {fmtMtime(entry.mtime)}
      </td>
    </tr>
  )
}
