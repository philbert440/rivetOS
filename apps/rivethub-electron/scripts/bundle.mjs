// Bundle the Electron main + preload with esbuild. CJS on purpose: Electron
// loads the main process fastest as CJS, and __dirname (used to locate the
// bundled web dist and icons) needs no import.meta shim.
import { build } from 'esbuild'

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}

await build({
  ...shared,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist-electron/main.cjs',
})

await build({
  ...shared,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
})
