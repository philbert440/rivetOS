import type { JSX } from 'react'
import { Select } from '../../components/select.js'
import type { FileEntry } from '@rivetos/types'
import { useFilesView, type SortKey } from './files-view-store.js'

/**
 * The Files toolbar: filter, sort, and the selection-driven actions row.
 * Stateless — owns no state: actions arrive via props, and the slices it
 * renders (notice, selection) are read straight from the files view store.
 */
export function FilesToolbar(props: {
  filter: string
  onFilter: (v: string) => void
  sort: SortKey
  onSort: (v: SortKey) => void
  busy: boolean
  /** The single selected entry; undefined unless exactly one row is selected. */
  renameTarget?: FileEntry
  onMkdir: () => void
  onRename: (entry: FileEntry) => void
  onDelete: () => void
  onCopyPaths: () => void
  onCopyUrls: () => void
  onUpload: (files: FileList) => void
}): JSX.Element {
  const notice = useFilesView((s) => s.notice)
  const selected = useFilesView((s) => s.selected)

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
          // The widget speaks strings; the store speaks SortKey. This is the
          // boundary where that conversion belongs.
          onChange={(v) => props.onSort(v as SortKey)}
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
          disabled={props.busy || !props.renameTarget}
          onClick={() => {
            if (props.renameTarget) props.onRename(props.renameTarget)
          }}
          className={actionCls}
        >
          Rename
        </button>
        <button
          type="button"
          disabled={props.busy || selected.size === 0}
          onClick={props.onDelete}
          className="rounded-pill border border-red/40 px-2 py-1 text-xs text-red hover:bg-red/10 disabled:opacity-40 classic:hover:bg-transparent classic:hover:border-red"
        >
          Delete
        </button>
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={props.onCopyPaths}
          className={actionCls}
        >
          Copy path
        </button>
        <button
          type="button"
          disabled={selected.size === 0}
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

      {notice && (
        <div
          className={`border-b border-line px-4 py-1.5 text-xs ${notice.kind === 'ok' ? 'text-em' : 'text-red'}`}
        >
          {notice.text}
          <button
            type="button"
            onClick={() => {
              useFilesView.getState().setNotice(undefined)
            }}
            className="ml-3 text-ink-dim hover:text-ink"
          >
            ✕
          </button>
        </div>
      )}
    </>
  )
}
