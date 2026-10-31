/**
 * FilesPage view state — filter, sort, selection, preview target, notice bar.
 * Zustand store so all Files components stay stateless and share one source.
 */

import { create, type StoreApi } from 'zustand'
import type { Notice } from './notice.js'

export type SortKey = 'name' | 'mtime' | 'size'

interface FilesViewState {
  filter: string
  sort: SortKey
  selected: Set<string>
  previewPath: string | undefined
  notice: Notice | undefined
  setFilter: (filter: string) => void
  setSort: (sort: SortKey) => void
  setSelected: (selected: Set<string>) => void
  toggleSelected: (name: string) => void
  setPreviewPath: (previewPath: string | undefined) => void
  setNotice: (notice: Notice | undefined) => void
}

export const useFilesView = create<FilesViewState>((set: StoreApi<FilesViewState>['setState']) => ({
  filter: '',
  sort: 'name',
  selected: new Set<string>(),
  previewPath: undefined,
  notice: undefined,
  setFilter: (filter) => set({ filter }),
  setSort: (sort) => set({ sort }),
  setSelected: (selected) => set({ selected }),
  toggleSelected: (name) =>
    set((s) => {
      const selected = new Set(s.selected)
      if (selected.has(name)) selected.delete(name)
      else selected.add(name)
      return { selected }
    }),
  setPreviewPath: (previewPath: string | undefined) => set({ previewPath }),
  setNotice: (notice: Notice | undefined) => set({ notice }),
}))
