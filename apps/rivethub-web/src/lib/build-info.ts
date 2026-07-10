/** Injected by vite `define` (vite.config.ts) — version + git sha + build
 *  time of this dist, surfaced in Settings so a stale desktop bundle is
 *  identifiable from the UI. A module (not an ambient .d.ts) so eslint's
 *  project service resolves the type on a fresh install too. */
declare const __BUILD_INFO__: {
  version: string
  sha: string
  builtAt: string
}

export const BUILD_INFO = __BUILD_INFO__
