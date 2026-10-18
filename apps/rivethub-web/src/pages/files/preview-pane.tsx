import type { JSX } from 'react'
import { baseName, previewKind } from '../../lib/files-ui.js'
import { saveViaGateway } from './save-via-gateway.js'
import { rivetShell } from '../../lib/shell-bridge.js'
import { FileEditor } from '../../components/file-editor.js'
import type { Notice } from './notice.js'

/**
 * The right-hand preview/edit pane of the Files page. Stateless w.r.t.
 * guard state: dirty reporting is an injected callback; the discard
 * decision belongs to the page.
 */
export function PreviewPane(props: {
  path: string
  downloadUrl: string
  onClose: () => void
  onNotice: (n: Notice) => void
  /** Optional size from the listing — drives previewKind / edit eligibility. */
  size?: number
}): JSX.Element {
  const name = baseName(props.path)
  // Prefer known size; when unknown assume under text cap for extension classification.
  const kind = previewKind(name, props.size ?? 100_000)
  const inShell = rivetShell() != null

  return (
    <aside className="flex w-[min(36rem,50%)] shrink-0 flex-col border-l border-line bg-panel/60">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-em">{props.path}</span>
        <a
          href={props.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          // In-shell only: target=_blank is denied and an OS browser cannot
          // authenticate to the gateway anyway — download over the app's
          // transport instead. Plain browsers keep real anchor semantics
          // (modifier-click, popup blocker).
          onClick={
            inShell
              ? (ev) => {
                  ev.preventDefault()
                  void saveViaGateway(props.downloadUrl, name, props.size)
                    .then(() => {
                      props.onNotice({ kind: 'ok', text: `download started: ${name}` })
                    })
                    .catch((err: unknown) => {
                      props.onNotice({ kind: 'err', text: (err as Error).message })
                    })
                }
              : undefined
          }
          className="text-xs text-ink-dim hover:text-em classic:text-[11px]"
        >
          {inShell ? 'download' : 'open'}
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
        <div className="p-3 text-xs text-ink-dim">
          No in-app preview for this type — use download / open.
        </div>
      )}
    </aside>
  )
}
