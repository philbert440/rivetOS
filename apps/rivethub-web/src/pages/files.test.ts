/**
 * Wiring pins for the Files page unsaved-edit guard.
 * Behaviour lives in src/lib/files-dirty-guard.test.ts (pure helpers) and
 * src/stores/ui-interaction.test.ts (state); these only assert the page
 * routes through both and the row hit-target markers.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const files = readFileSync(new URL('./files.tsx', import.meta.url), 'utf8')

describe('files page unsaved-edit guard wiring', () => {
  it('uses the pure dirty-guard helpers', () => {
    expect(files).toContain("from '../lib/files-dirty-guard.js'")
    expect(files).toContain('guardPathNav')
    expect(files).toContain('guardOpenFile')
    expect(files).toContain('guardClosePreview')
    expect(files).toContain('discardMessage')
    expect(files).toContain('shouldIgnoreRowActivate')
  })

  it('guard state comes from the ui-interaction store, not a ref', () => {
    expect(files).toContain("from '../stores/ui-interaction.js'")
    expect(files).toContain('useUiInteraction((s) => s.filesDirty)')
    expect(files).not.toContain('editorDirtyRef')
  })

  it('blocks route changes while dirty via useBlocker', () => {
    expect(files).toContain('useBlocker({ shouldBlockFn, enableBeforeUnload })')
    expect(files).toContain('const shouldBlockFn = useCallback(')
    expect(files).toContain('enableBeforeUnload = useCallback(() => filesDirty.dirty,')
  })

  it('same-path navigation no-ops before setPath', () => {
    expect(files).toContain("if (guardPathNav(path, next) === 'noop') return")
  })

  it('row hit-target excludes the checkbox cell and marks cursor-pointer', () => {
    expect(files).toContain('data-no-open')
    expect(files).toContain('cursor-pointer')
    expect(files).toContain('shouldIgnoreRowActivate')
  })
})
