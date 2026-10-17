/**
 * Edit a project: its name, the directory its sessions start in, and the
 * node they start on. Running sessions are not rewritten. The project
 * directory wins over every agent's own; left empty, each agent starts in
 * its preset directory. Agent, model and effort are chosen per session, so
 * Save clears any the project still carries from before.
 */

import { useState, type JSX } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { FolderOpen } from 'lucide-react'
import { isLocalDenUrl } from '../../lib/gateway-url.js'
import { rivetShell } from '../../lib/shell-bridge.js'
import { useConnection } from '../../stores/connection.js'
import { asDirectory, useSpaces, type SpaceDef } from '../../stores/spaces.js'
import { NodePicker } from '../pickers/node-picker.js'

export function SpaceDefaultsDialog(props: { space: SpaceDef; onClose: () => void }): JSX.Element {
  const stored = props.space.defaults
  const [name, setName] = useState(props.space.name)
  const [node, setNode] = useState(stored?.node ?? '')
  const [directory, setDirectory] = useState(stored?.directory ?? '')
  const directoryBad = directory.trim() !== '' && asDirectory(directory) === undefined
  // The directory is checked and used on the node, so the chooser (which
  // browses this machine) is offered only when that node is this machine's
  // own den. Desktop only: the browser has no way to hand back a real path.
  const hubUrl = useConnection((state) => state.baseUrl)
  const shell = rivetShell()
  const canBrowse = typeof shell?.pickDirectory === 'function' && isLocalDenUrl(node || hubUrl)

  const browse = async (): Promise<void> => {
    if (!shell?.pickDirectory) return
    const picked = await shell.pickDirectory(asDirectory(directory))
    if (picked) setDirectory(picked)
  }

  const save = (): void => {
    const trimmed = name.trim()
    if (!trimmed || directoryBad) return
    useSpaces.getState().renameSpace(props.space.id, trimmed)
    useSpaces.getState().setSpaceDefaults(props.space.id, {
      agentId: undefined,
      model: undefined,
      effort: undefined,
      harnessId: undefined,
      node: node || undefined,
      directory: asDirectory(directory),
    })
    props.onClose()
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 classic:bg-bg/70" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[28rem] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 border border-line bg-panel p-4 shadow-pop outline-none material:rounded-3xl material:border-transparent material:bg-surface material:p-6">
          <Dialog.Title className="mb-5 text-sm leading-relaxed text-ink-dim classic:mb-3 classic:text-ink">
            Edit project
          </Dialog.Title>
          <Dialog.Description className="mb-3 text-xs text-ink-dim">
            New sessions in this project start with these. Sessions already running are not changed.
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <label className="mb-1 block text-xs text-ink-dim" htmlFor="space-name">
              Name
            </label>
            <input
              id="space-name"
              autoFocus
              aria-label="Project name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name"
              className="mb-3 w-full border border-line bg-bg px-2 py-1.5 text-sm text-ink outline-none material:rounded-lg"
            />
            <label className="mb-1 block text-xs text-ink-dim" htmlFor="space-directory">
              Directory on the node
            </label>
            <div className="flex items-stretch gap-2">
              <input
                id="space-directory"
                aria-label="Project directory"
                aria-invalid={directoryBad || undefined}
                value={directory}
                onChange={(event) => setDirectory(event.target.value)}
                placeholder="Each agent's own directory"
                spellCheck={false}
                className="min-w-0 flex-1 border border-line bg-bg px-2 py-1.5 font-mono text-sm text-ink outline-none placeholder:font-sans placeholder:text-ink-dim aria-invalid:border-red material:rounded-lg"
              />
              {canBrowse ? (
                <button
                  type="button"
                  data-browse-directory=""
                  onClick={() => void browse()}
                  className="flex shrink-0 items-center gap-1.5 border border-line px-3 text-xs text-ink hover:text-em material:rounded-pill material:hover:bg-ink/6"
                >
                  <FolderOpen aria-hidden="true" className="size-4" />
                  Browse…
                </button>
              ) : null}
            </div>
            <p className={`mb-3 mt-1 text-xs ${directoryBad ? 'text-red' : 'text-ink-dim'}`}>
              {directoryBad
                ? 'Use a full path that starts with /'
                : 'A folder on the node below. Every agent started here works in it, unless you pick another for that session.'}
            </p>
            <div className="mb-3">
              <span className="mb-1 block text-xs text-ink-dim">Node</span>
              <NodePicker selected={node} onSelect={setNode} />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={props.onClose}
                className="border border-line px-3 py-1.5 text-xs text-ink-dim hover:text-ink material:rounded-pill material:hover:bg-ink/6"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim() || directoryBad}
                className="bg-em px-3 py-1.5 text-xs font-medium text-on-em hover:bg-em-dim disabled:opacity-40 classic:bg-em-dim classic:hover:bg-em classic:text-bg"
              >
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
