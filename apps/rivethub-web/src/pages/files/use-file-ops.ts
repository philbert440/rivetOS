import { useState } from 'react'
import { GatewayError } from '@rivetos/gateway-client'
import type { FileEntry } from '@rivetos/types'
import { joinRel } from '../../lib/files-ui.js'
import { copyTextToClipboard } from '../../lib/clipboard.js'
import { useGateway } from '../../lib/use-gateway.js'
import type { Notice } from './notice.js'

/**
 * The Files page mutation operations: upload (with 409-overwrite confirm),
 * mkdir, rename, delete (with recursive confirm), move-onto-dir, copy
 * paths/URLs. Owns the busy flag and the transient notice bar; refresh and
 * the confirm/prompt functions are injected by the page.
 *
 * Ops that can invalidate the open preview buffer receive callbacks
 * (`onPreviewRenamed`, `onPreviewDeleted`) so the page keeps owning its
 * previewPath state.
 */
export function useFileOps(args: {
  path: string
  refresh: () => Promise<void>
  confirm: (message: string, opts?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  prompt: (message: string, opts?: { defaultValue?: string }) => Promise<string | null | undefined>
  onPreviewRenamed: (from: string, to: string) => void
  onPreviewDeleted: (deletedPaths: string[]) => void
}): {
  busy: boolean
  notice: Notice | undefined
  showNotice: (n: Notice) => void
  setNotice: (n: Notice | undefined) => void
  upload: (files: FileList | File[]) => Promise<void>
  uploadInto: (dirPath: string, files: FileList | File[]) => Promise<void>
  mkdir: () => Promise<void>
  renameOne: (entry: FileEntry) => Promise<void>
  deleteSelected: (selected: Set<string>, entries: FileEntry[]) => Promise<void>
  moveOntoDir: (srcName: string, destDirName: string) => Promise<void>
  copyPaths: (selected: Set<string>) => Promise<void>
  copyUrls: (selected: Set<string>, entries: FileEntry[]) => Promise<void>
} {
  const { path, refresh, confirm, prompt, onPreviewRenamed, onPreviewDeleted } = args
  const gateway = useGateway()
  const [busy, setBusy] = useState(false)
  const [notice, setNoticeState] = useState<Notice | undefined>()

  const showNotice = (n: Notice): void => setNoticeState(n)

  const uploadInto = async (dirPath: string, files: FileList | File[]): Promise<void> => {
    setBusy(true)
    let ok = 0
    const errors: string[] = []
    for (const file of Array.from(files)) {
      try {
        await gateway.filesUpload(dirPath, file.name, file)
        ok += 1
      } catch (err) {
        if (err instanceof GatewayError && err.status === 409) {
          if (await confirm(`${file.name} already exists — overwrite?`)) {
            try {
              await gateway.filesUpload(dirPath, file.name, file, { overwrite: true })
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
        : {
            kind: 'ok',
            text:
              dirPath === path
                ? `uploaded ${String(ok)} file${ok === 1 ? '' : 's'}`
                : `uploaded ${String(ok)} into ${dirPath.split('/').pop() ?? dirPath}/`,
          },
    )
  }

  const upload = async (files: FileList | File[]): Promise<void> => {
    await uploadInto(path, files)
  }

  const mkdir = async (): Promise<void> => {
    const name = await prompt('New folder name')
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
    const next = await prompt('Rename to', { defaultValue: entry.name })
    if (!next?.trim() || next.trim() === entry.name) return
    const from = joinRel(path, entry.name)
    const to = joinRel(path, next.trim())
    setBusy(true)
    try {
      await gateway.filesRename(from, to)
      onPreviewRenamed(from, to)
      await refresh()
      showNotice({ kind: 'ok', text: `renamed → ${next.trim()}` })
    } catch (err) {
      showNotice({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async (selected: Set<string>, entries: FileEntry[]): Promise<void> => {
    const names = [...selected]
    if (names.length === 0) return
    if (!(await confirm(`Delete ${String(names.length)} item(s)?`, { danger: true }))) return
    setBusy(true)
    const errors: string[] = []
    for (const name of names) {
      const rel = joinRel(path, name)
      const entry = entries.find((e) => e.name === name)
      try {
        await gateway.filesDelete(rel)
      } catch (err) {
        if (
          err instanceof GatewayError &&
          err.status === 409 &&
          entry?.type === 'dir' &&
          (await confirm(`${name}/ is not empty — delete recursively?`, { danger: true }))
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
    const deletedPaths = names.map((n) => joinRel(path, n))
    onPreviewDeleted(deletedPaths)
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
      await refresh()
      showNotice({ kind: 'ok', text: `moved ${srcName} → ${destDirName}/` })
    } catch (err) {
      showNotice({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const copyPaths = async (selected: Set<string>): Promise<void> => {
    const lines = [...selected].map((n) => joinRel(path, n))
    if (lines.length === 0) return
    try {
      await copyTextToClipboard(lines.join('\n'))
      showNotice({ kind: 'ok', text: 'path(s) copied' })
    } catch {
      showNotice({ kind: 'err', text: 'copy failed' })
    }
  }

  const copyUrls = async (selected: Set<string>, entries: FileEntry[]): Promise<void> => {
    const lines = [...selected]
      .map((n) => {
        const e = entries.find((x) => x.name === n)
        if (!e || e.type !== 'file') return null
        return gateway.fileDownloadUrl(joinRel(path, n))
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

  return {
    busy,
    notice,
    showNotice,
    setNotice: setNoticeState,
    upload,
    uploadInto,
    mkdir,
    renameOne,
    deleteSelected,
    moveOntoDir,
    copyPaths,
    copyUrls,
  }
}
