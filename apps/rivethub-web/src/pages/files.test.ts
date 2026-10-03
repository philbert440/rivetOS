import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const files = readFileSync(new URL('./files.tsx', import.meta.url), 'utf8')

function body(startMarker: string, endMarker: string): string {
  const start = files.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const end = files.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return files.slice(start, end)
}

const openEntry = body('const openEntry = useCallback', 'const openRaw = useCallback')
const openRaw = body('const openRaw = useCallback', 'const refresh = useCallback')
const closeHandler = body('onClose={() => {', 'onNotice={showNotice}')
const rows = body('entries.map', '</table>')

describe('files page unsaved-edit guard', () => {
  it('the preview editor reports dirty state upward', () => {
    expect(files).toContain('onDirtyChange: (dirty: boolean) => void')
    expect(files).toContain('onDirtyChange={props.onDirtyChange}')
    expect(files).toContain('onDirtyChange={setEditorDirtyTracked}')
  })

  it('closing the pane confirms before discarding', () => {
    expect(closeHandler).toContain('await confirmDiscard()')
    expect(closeHandler).toContain('setPreviewPath(undefined)')
    // The confirm has to gate the close, not merely precede it in the file.
    expect(closeHandler.indexOf('confirmDiscard')).toBeLessThan(
      closeHandler.indexOf('setPreviewPath'),
    )
  })

  it('opening another entry confirms before discarding', () => {
    expect(openEntry).toContain('await confirmDiscard()')
    expect(openEntry.indexOf('confirmDiscard')).toBeLessThan(openEntry.indexOf('setPreviewPath'))
    expect(openEntry.indexOf('confirmDiscard')).toBeLessThan(openEntry.indexOf('setPath('))
  })

  it('clicking the already-open file is a no-op', () => {
    // React bails on a same-value setState, so the buffer would not reload.
    expect(openEntry).toContain('if (!isDir && child === previewPath) return')
    expect(openEntry.indexOf('child === previewPath')).toBeLessThan(
      openEntry.indexOf('confirmDiscard'),
    )
  })

  it('guards read the ref, which is current at click time', () => {
    expect(files).toContain('editorDirtyRef.current')
    expect(files).toMatch(/const confirmDiscard = useCallback\(async[\s\S]*?if \(!editorDirtyRef\.current\) return true/)
  })

  it('an accepted discard clears dirty before the preview is dropped', () => {
    // Otherwise the path effect prompts a second time for the same answer.
    expect(files).toMatch(
      /const ok = await discardConfirm\('Discard unsaved changes\?'\)[\s\S]*?if \(ok\) setEditorDirtyTracked\(false\)/,
    )
  })

  it('dirty state is reset when the previewed file changes', () => {
    expect(files).toMatch(
      /useEffect\(\(\) => \{[\s\S]*?setEditorDirtyTracked\(false\)[\s\S]*?\}, \[previewPath, setEditorDirtyTracked\]\)/,
    )
  })

  it('a dirty editor warns on tab close / reload', () => {
    expect(files).toMatch(/if \(!editorDirty\) return/)
    expect(files).toContain("window.addEventListener('beforeunload', onUnload)")
    expect(files).toContain('e.preventDefault()')
  })

  it('the whole file row is the click target, not just the name button', () => {
    expect(rows).toMatch(/<tr[\s\S]*?onClick=\{\(ev\) => \{/)
    // The checkbox cell selects; it must not also open the file.
    expect(rows).toContain("closest('input, label')")
  })

  it('row click opens through the guard and double-click is gated while dirty', () => {
    expect(rows).toContain('void openEntry(child, e.type ===')
    expect(rows).toContain('openRaw(e, child)')
    expect(openRaw).toMatch(/if \(editorDirtyRef\.current\)[\s\S]*?showNotice/)
  })

  it('breadcrumb and parent-row navigation run through the dirty guard', () => {
    expect(files).toMatch(/onClick=\{\(\) => void navigateGuarded\(''\)\}/)
    expect(files).toContain('void navigateGuarded(crumbs.slice(0, i + 1)')
    expect(files).toContain('void navigateGuarded(parentRel(path))')
  })

  it('every navigation entry point is guarded', () => {
    const unguarded = [...files.matchAll(/onClick=\{\(\) => (setPath\([^)]*\))\}/g)].map((m) => m[1])
    expect(unguarded).toEqual([])
  })

  it('the confirm dialog element is rendered on the page', () => {
    expect(files).toContain('{discardDialog.element}')
  })

  it('confirm is called on the same dialog instance that is mounted', () => {
    expect(files).toContain('const discardConfirm = discardDialog.confirm')
    expect(files).not.toMatch(/const \{ confirm: discardConfirm \} = useConfirmDialog/)
  })
})
