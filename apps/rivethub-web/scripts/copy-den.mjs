// Bundle the den viewer under dist/den/ so a node that points
// den.static_dir at rivethub-web keeps its diorama at /den/ (RivetHub links
// out to it — the den embed was cut from v1 by design).
//
// This is a real second vite build with --base=/den/, NOT a copy of den's
// root-base dist: den's default build references /assets/* absolutely, which
// would resolve into rivethub's bundle under a co-located root (#297 review).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const denApp = join(here, '..', '..', 'den')
const target = join(here, '..', 'dist', 'den')

if (!existsSync(join(denApp, 'index.html'))) {
  console.error(`copy-den: den app not found at ${denApp}`)
  process.exit(1)
}
execFileSync('npx', ['vite', 'build', '--base=/den/', '--outDir', target, '--emptyOutDir'], {
  cwd: denApp,
  stdio: 'inherit',
})
console.log('copy-den: den viewer built at dist/den/ (base=/den/)')
