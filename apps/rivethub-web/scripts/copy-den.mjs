// Bundle the den viewer under dist/den/ so a node that points
// den.static_dir at rivethub-web keeps its diorama at /den/ (RivetHub
// links out to it — the den embed was cut from v1 by design).
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const denDist = join(here, '..', '..', 'den', 'dist')
const target = join(here, '..', 'dist', 'den')

if (!existsSync(denDist)) {
  console.error(`copy-den: den viewer dist not found at ${denDist} — run den-app build first`)
  process.exit(1)
}
mkdirSync(target, { recursive: true })
cpSync(denDist, target, { recursive: true })
console.log(`copy-den: den viewer bundled at dist/den/`)
