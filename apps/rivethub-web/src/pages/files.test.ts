import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const files = readFileSync(new URL('./files.tsx', import.meta.url), 'utf8')

describe('files page unsaved-edit guard', () => {
  it('the preview editor reports dirty state upward', () => {
    expect(files).toContain('onDirtyChange: (dirty: boolean) => void')
    expect(files).toContain('onDirtyChange={props.onDirtyChange}')
    expect(files).toContain('onDirtyChange={setEditorDirtyTracked}')
  })

  it('closing the pane confirms before discarding', () => {
    expect(files).toContain("discardConfirm('Discard unsaved changes?')")
    // Guards read the ref: state settles after the click that checks it.
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

  it('clicking the already-open file is a no-op', () => {
    // React bails on a same-value setState, so the buffer would not reload.
    expect(files).toContain('if (!isDir && child === previewPath) return')
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