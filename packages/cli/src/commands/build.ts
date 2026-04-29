/**
 * rivetos build
 *
 * Build container images from source.
 *
 *   rivetos build              — build all images (agent + datahub)
 *   rivetos build agent        — build agent image only
 *   rivetos build datahub      — build datahub image only
 *   rivetos build --tag v1.0   — tag with a specific version
 *   rivetos build --push       — push to registry after build
 */

import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..', '..', '..')

interface BuildOptions {
  targets: ('agent' | 'datahub')[]
  tag: string
  push: boolean
  platform?: string
}

function parseArgs(): BuildOptions {
  const args = process.argv.slice(3)
  const targets: ('agent' | 'datahub')[] = []
  let tag = 'latest'
  let push = false
  let platform: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === 'agent' || arg === 'datahub') {
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

  // Default: build both
  if (targets.length === 0) {
    targets.push('agent', 'datahub')
  }

  return { targets, tag, push, platform }
}

function showHelp(): void {
  console.log(`
  rivetos build — Build container images from source

  Usage:
    rivetos build [target...] [options]

  Targets:
    agent       Build the agent runtime image
    datahub     Build the datahub (Postgres + shared storage) image
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
      timeout: 600000, // 10 min per build
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
    })
  } catch {
    console.error(`\n❌ ${label} failed.`)
    process.exit(1)
  }
}

export default async function build(): Promise<void> {
  const opts = parseArgs()

  // Get git SHA for labeling
  let sha = 'unknown'
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim()
  } catch {
    /* not in a git repo */
  }

  // Get version from package.json
  let version = '0.0.0'
  try {
    const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf-8')) as {
      version?: string
    }
    version = pkg.version ?? '0.0.0'
  } catch {
    /* ignore */
  }

  // Registry prefix from environment or default
  const registry = process.env.RIVETOS_REGISTRY ?? 'ghcr.io/philbert440'

  console.log(`RivetOS Build`)
  console.log(`  Version:  ${version} (${sha})`)
  console.log(`  Registry: ${registry}`)
  console.log(`  Targets:  ${opts.targets.join(', ')}`)
  console.log(`  Tag:      ${opts.tag}`)
  console.log('')

  for (const target of opts.targets) {
    const imageName = target === 'agent' ? 'rivetos-agent' : 'rivetos-datahub'
    const fullTag = `${registry}/${imageName}:${opts.tag}`
    const shaTag = `${registry}/${imageName}:${sha}`
    const dockerfile =
      target === 'agent'
        ? 'apps/infra/containers/agent/Dockerfile'
        : 'apps/infra/containers/datahub/Dockerfile'
    const context = target === 'agent' ? '.' : 'apps/infra/containers/datahub'

    console.log(`Building ${target}...`)

    let buildCmd = `docker build -f ${dockerfile} -t ${fullTag} -t ${shaTag}`

    // Add build args
    buildCmd += ` --build-arg VERSION=${version}`
    buildCmd += ` --build-arg GIT_SHA=${sha}`

    // Multi-platform support
    if (opts.platform) {
      buildCmd += ` --platform ${opts.platform}`
    }

    buildCmd += ` ${context}`

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
