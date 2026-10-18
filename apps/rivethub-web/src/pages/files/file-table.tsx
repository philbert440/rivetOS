import type { JSX } from 'react'
import type { FileEntry } from '@rivetos/types'
import { joinRel } from '../../lib/files-ui.js'
import { selectionTextWithin, shouldIgnoreRowActivate } from '../../lib/files-dirty-guard.js'
import { fmtSize, fmtMtime } from './format.js'

/**
 * The Files listing table: rows, selection, row activation (open entry),
 * double-click raw open, drag-to-move / drop-into-dir. Stateless w.r.t.
 * guard state — the page owns the discard decision; this component only
 * emits `onOpenEntry` / `onOpenRaw` / `onMoveOntoDir` / `onDropFilesInto`.
 */
export function FileTable(props: {
  path: string
  entries: FileEntry[]
  loading: boolean
  error?: Error
  filterActive: boolean
  selected: Set<string>
  onToggleSelectAll: (names: Set<string>) => void
  onToggleSelect: (name: string) => void
  onOpenEntry: (child: string, isDir: boolean) => void
  onOpenRaw: (entry: FileEntry, child: string) => void
  onMoveOntoDir: (srcName: string, destDirName: string) => void
  onDropFilesInto: (dirPath: string, files: FileList | File[]) => void
  onNavigateUp: () => void
  /** Ignore openRaw briefly after a dir navigate so a folder double-click
   *  does not act on whatever row lands under the pointer in the next listing. */
  suppressRawUntil: { current: number }
}): JSX.Element {
  const allNames = props.entries.map((e) => e.name)
  const allSelected = allNames.length > 0 && allNames.every((n) => props.selected.has(n))

  return (
    <div className="min-w-0 flex-1 overflow-y-auto px-4 py-2">
      {props.error ? (
        <div className="py-6 text-sm text-red">{props.error.message}</div>
      ) : props.entries.length === 0 && !props.loading ? (
        <div className="py-6 text-sm text-ink-dim">
          {props.filterActive ? 'No matches.' : 'Empty directory — drop files here or use Upload.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] text-ink-dim classic:text-[10px]">
                <th className="w-8 py-1 pr-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => {
                      props.onToggleSelectAll(allSelected ? new Set() : new Set(allNames))
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
              {props.path !== '' && (
                <tr className="border-b border-line/40">
                  <td />
                  <td colSpan={3} className="py-1">
                    <button
                      type="button"
                      onClick={props.onNavigateUp}
                      className="text-ink-dim hover:text-ink"
                    >
                      ../
                    </button>
                  </td>
                </tr>
              )}
              {props.entries.map((e) => {
                const child = joinRel(props.path, e.name)
                const isSel = props.selected.has(e.name)
                const activateRow = (ev: {
                  detail: number
                  target: EventTarget | null
                  currentTarget: EventTarget | null
                }): void => {
                  // Only a selection inside this row is a drag-select of
                  // its name; one elsewhere (the editor) must not eat the click.
                  const row = (ev.currentTarget as HTMLElement | null)?.closest('tr') ?? null
                  if (
                    shouldIgnoreRowActivate({
                      detail: ev.detail,
                      target: ev.target,
                      selectionText: selectionTextWithin(window.getSelection(), row),
                    })
                  ) {
                    return
                  }
                  props.onOpenEntry(child, e.type === 'dir')
                }
                return (
                  <tr
                    key={e.name}
                    className={`cursor-pointer border-b border-line/40 hover:bg-panel-2/50 ${
                      isSel ? 'bg-panel-2/40' : ''
                    }`}
                    onClick={(ev) => {
                      activateRow(ev)
                    }}
                    onDoubleClick={(ev) => {
                      if (performance.now() < props.suppressRawUntil.current) return
                      if (
                        // A double-click selects the word under it; that
                        // is not a drag-select, so no selection check here.
                        shouldIgnoreRowActivate({ detail: 1, target: ev.target })
                      ) {
                        return
                      }
                      props.onOpenRaw(e, child)
                    }}
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
                            if (src) props.onMoveOntoDir(src, e.name)
                            else if (ev.dataTransfer.files.length > 0) {
                              // Drop OS files into this subdirectory
                              props.onDropFilesInto(child, ev.dataTransfer.files)
                            }
                          }
                        : undefined
                    }
                  >
                    <td className="py-1.5 pr-2" data-no-open>
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => {
                          props.onToggleSelect(e.name)
                        }}
                        aria-label={`select ${e.name}`}
                      />
                    </td>
                    <td className="py-1.5 pr-4">
                      <button
                        type="button"
                        className="flex items-center gap-2 text-left"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          activateRow(ev)
                        }}
                      >
                        <span className="w-4 text-center text-ink-dim">
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
        </div>
      )}
    </div>
  )
}
