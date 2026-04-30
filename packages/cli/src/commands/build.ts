/**
 * rivetos build
 *
 * Build container images from source.
 *
 *   rivetos build              — build all images (rivetos + datahub)
 *   rivetos build rivetos      — build the unified rivetos image only
 *   rivetos build datahub      — build the datahub image only
 *   rivetos build --tag v1.0   — tag with a specific version
 *   rivetos build --push       — push to registry after build
 */

import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

type Target = 'rivetos' | 'datahub'

interface BuildOptions {
  targets: Target[]
  tag: string
  push: boolean
  platform?: string
}

const TARGETS: Record<Target, { image: string; dockerfile: string; context: string }> = {
  rivetos: {
    image: 'rivetos',
    dockerfile: 'infra/containers/rivetos/Dockerfile',
    context: '.',
  },
  datahub: {
    image: 'rivetos-datahub',
    dockerfile: 'infra/containers/datahub/Dockerfile',
    context: '.',
  },
}

function parseArgs(): BuildOptions {
  const args = process.argv.slice(3)
  const targets: Target[] = []
  let tag = 'latest'
  let push = false
  let platform: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === 'rivetos' || arg === 'datahub') {
      targets.push(arg)
    } else if (arg === '--tag' || arg === '-t') {
      tag = args[++i] ?? 'latest'
    } else if (arg === '--push') {
      push = true
    } else if (arg === '--platform') {
      platform = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      showHelp()
      process.exit(0)
    }
  }

  if (targets.length === 0) {
    targets.push('rivetos', 'datahub')
  }

  return { targets, tag, push, platform }
}

function showHelp(): void {
  console.log(`
  rivetos build — Build container images from source

  Usage:
    rivetos build [target...] [options]

  Targets:
    rivetos     Build the unified rivetos runtime image (agent | worker | migrate roles)
    datahub     Build the datahub (Postgres + pgvector) image
    (default)   Build both

  Options:
    --tag, -t <tag>     Image tag (default: "latest")
    --push              Push to registry after build
    --platform <arch>   Build for specific platform (e.g., "linux/amd64,linux/arm64")
  `)
}

function exec(cmd: string, label: string): void {
  console.log(`  $ ${cmd}`)
  try {
    execSync(cmd, {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 600000,
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
    })
  } catch {
    console.error(`\n❌ ${label} failed.`)
    process.exit(1)
  }
}

export default async function build(): Promise<void> {
  const opts = parseArgs()

  let sha = 'unknown'
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim()
  } catch {
    /* not in a git repo */
  }

  let version = '0.0.0'
  try {
    const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf-8')) as {
      version?: string
    }
    version = pkg.version ?? '0.0.0'
  } catch {
    /* ignore */
  }

  const registry = process.env.RIVETOS_REGISTRY ?? 'ghcr.io/philbert440'

  console.log(`RivetOS Build`)
  console.log(`  Version:  ${version} (${sha})`)
  console.log(`  Registry: ${registry}`)
  console.log(`  Targets:  ${opts.targets.join(', ')}`)
  console.log(`  Tag:      ${opts.tag}`)
  console.log('')

  for (const target of opts.targets) {
    const t = TARGETS[target]
    const fullTag = `${registry}/${t.image}:${opts.tag}`
    const shaTag = `${registry}/${t.image}:${sha}`

    console.log(`Building ${target}...`)

    let buildCmd = `docker build -f ${t.dockerfile} -t ${fullTag} -t ${shaTag}`
    buildCmd += ` --build-arg VERSION=${version}`
    buildCmd += ` --build-arg GIT_SHA=${sha}`

    if (opts.platform) {
      buildCmd += ` --platform ${opts.platform}`
    }

    buildCmd += ` ${t.context}`

    exec(buildCmd, `${target} build`)
    console.log(`  ✅ ${fullTag}`)

    if (opts.push) {
      console.log(`  Pushing ${fullTag}...`)
      exec(`docker push ${fullTag}`, `${target} push`)
      exec(`docker push ${shaTag}`, `${target} push (sha)`)
      console.log(`  ✅ Pushed.`)
    }

    console.log('')
  }

  console.log(`✅ Build complete.`)
}
