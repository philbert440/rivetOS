import type { JSX } from 'react'
import { Select } from '../../components/select.js'
import type { FileEntry } from '@rivetos/types'
import type { Notice } from './notice.js'

/**
 * The Files toolbar: filter, sort, and the selection-driven actions row.
 * Stateless: all mutations and state come in via props.
 */
export function FilesToolbar(props: {
  filter: string
  onFilter: (v: string) => void
  sort: string
  onSort: (v: string) => void
  busy: boolean
  selected: Set<string>
  entries: FileEntry[]
  notice: Notice | undefined
  onDismissNotice: () => void
  onMkdir: () => void
  onRename: (entry: FileEntry) => void
  onDelete: () => void
  onCopyPaths: () => void
  onCopyUrls: () => void
  onUpload: (files: FileList) => void
}): JSX.Element {
  const findSelected = (): FileEntry | undefined => {
    const name = [...props.selected][0]
    return props.entries.find((e) => e.name === name)
  }

  const actionCls =
    'rounded-pill border border-line px-2 py-1 text-xs hover:bg-ink/6 disabled:opacity-40 classic:hover:bg-transparent classic:hover:border-em'

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <input
          value={props.filter}
          onChange={(e) => props.onFilter(e.target.value)}
          placeholder="Filter…"
          className="w-40 rounded-lg border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-em"
        />
        <Select
          value={props.sort}
          title="sort"
          label="Sort"
          onChange={props.onSort}
          options={[
            { value: 'name', label: 'sort: name' },
            { value: 'mtime', label: 'sort: mtime' },
            { value: 'size', label: 'sort: size' },
          ]}
        />
        <button type="button" disabled={props.busy} onClick={props.onMkdir} className={actionCls}>
          New folder
        </button>
        <button
          type="button"
          disabled={props.busy || props.selected.size !== 1}
          onClick={() => {
            const entry = findSelected()
            if (entry) props.onRename(entry)
          }}
          className={actionCls}
        >
          Rename
        </button>
        <button
          type="button"
          disabled={props.busy || props.selected.size === 0}
          onClick={props.onDelete}
          className="rounded-pill border border-red/40 px-2 py-1 text-xs text-red hover:bg-red/10 disabled:opacity-40 classic:hover:bg-transparent classic:hover:border-red"
        >
          Delete
        </button>
        <button
          type="button"
          disabled={props.selected.size === 0}
          onClick={props.onCopyPaths}
          className={actionCls}
        >
          Copy path
        </button>
        <button
          type="button"
          disabled={props.selected.size === 0}
          onClick={props.onCopyUrls}
          className={actionCls}
        >
          Copy URL
        </button>
        <label className={`cursor-pointer ${actionCls}`}>
          Upload…
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) props.onUpload(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
      </div>

      {props.notice && (
        <div
          className={`border-b border-line px-4 py-1.5 text-xs ${props.notice.kind === 'ok' ? 'text-em' : 'text-red'}`}
        >
          {props.notice.text}
          <button
            type="button"
            onClick={props.onDismissNotice}
            className="ml-3 text-ink-dim hover:text-ink"
          >
            ✕
          </button>
        </div>
      )}
    </>
  )
}
