// The Files page editor must not silently discard unsaved edits (#964):
// closing the preview pane, switching files, and closing the browser tab are
// all guarded. The page mounts through routers/gateway hooks that pull in the
// whole connection store, so — matching the repo's render-contract idiom
// (chat.test.ts) — these scans pin the wiring in pages/files.tsx itself. Each
// assertion fails if the dirty guard is unwired or removed.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const files = readFileSync(new URL('./files.tsx', import.meta.url), 'utf8')

describe('files page unsaved-edit guard (#964)', () => {
  it('the preview editor reports dirty state upward', () => {
    // PreviewPane declares the prop and forwards it into the CodeMirror host.
    expect(files).toContain('onDirtyChange: (dirty: boolean) => void')
    expect(files).toContain('onDirtyChange={props.onDirtyChange}')
    // The page hands the editor a tracked setter, not a bare reset.
    expect(files).toContain('onDirtyChange={setEditorDirtyTracked}')
  })

  it('closing the pane confirms before discarding', () => {
    expect(files).toContain("discardConfirm('Discard unsaved changes?')")
    // The guard reads the ref (live value), not render-lagged state.
    expect(files).toContain('editorDirtyRef.current')
  })

  it('dirty state is reset when the previewed file changes', () => {
    expect(files).toMatch(
      /useEffect\(\(\) => \{[\s\S]*?setEditorDirtyTracked\(false\)[\s\S]*?\}, \[previewPath, setEditorDirtyTracked\]\)/,
    )
  })

  it('the whole file row is the click target, not just the name button', () => {
    const row = files.slice(files.indexOf('entries.map'), files.indexOf('</table>'))
    expect(row).toMatch(/<tr[\s\S]*?onClick=\{\(ev\) => \{/)
    expect(row).toContain("closest('input, label')")
  })

  it('a dirty editor warns on tab close / reload', () => {
    expect(files).toMatch(/if \(!editorDirty\) return/)
    expect(files).toContain("window.addEventListener('beforeunload', onUnload)")
    expect(files).toContain('e.preventDefault()')
  })

  it('the confirm dialog element is rendered on the page', () => {
    expect(files).toContain('{discardDialog.element}')
  })

  it('confirm is called on the same dialog instance that is mounted', () => {
    expect(files).toContain('const discardConfirm = discardDialog.confirm')
    expect(files).not.toMatch(/const \{ confirm: discardConfirm \} = useConfirmDialog/)
  })
})