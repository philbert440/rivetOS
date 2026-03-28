/**
 * rivetos keys — SSH key management for the mesh.
 *
 * Usage:
 *   rivetos keys rotate         Push new SSH key to all nodes (uses fallback password if SSH fails)
 *   rivetos keys list            Show which nodes have your key
 *   rivetos keys status          Show key status across the mesh
 *
 * The control plane's SSH key is the primary access method for all nodes.
 * If the key changes (new machine, regenerated key), use `rivetos keys rotate`
 * to push the new key to all nodes. The fallback password (set during provisioning)
 * is used when SSH key auth fails.
 */

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'

const HELP = `
  rivetos keys — SSH key management

  Commands:
    rivetos keys rotate           Push new SSH key to all provisioned nodes
    rivetos keys list             Show key status for each node
    rivetos keys status           Summary of key access across the mesh

  How it works:
    When you provision nodes, your SSH public key is added to each one.
    If your key ever changes (new machine, regenerated), use 'rotate' to
    push the new key. It tries SSH first; if that fails, it falls back
    to the password you set during provisioning.
`

interface NodesFile {
  fallback_password: string
  nodes: Record<
    string,
    {
      hostname: string
      ip: string
      agent: string
      provider: string
      pve_node: string
      provisioned_at: string
    }
  >
}

export default async function keys(): Promise<void> {
  const args = process.argv.slice(3)
  const subcommand = args[0]

  switch (subcommand) {
    case 'rotate':
      await keysRotate()
      break
    case 'list':
    case 'status':
      await keysList()
      break
    default:
      console.log(HELP)
  }
}

async function loadNodesFile(): Promise<NodesFile | null> {
  // Look for .secrets/nodes.json relative to repo root
  const paths = [
    resolve(process.cwd(), '.secrets', 'nodes.json'),
    resolve(
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dirname may be undefined in older Node
      dirname(dirname(dirname(dirname(dirname(import.meta.dirname ?? '.'))))),
      '.secrets',
      'nodes.json',
    ),
  ]

  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8')
      return JSON.parse(raw) as NodesFile
    } catch {
      // try next
    }
  }

  return null
}

function getPublicKey(): string | null {
  const home = homedir()
  const keyPaths = [resolve(home, '.ssh', 'id_ed25519.pub'), resolve(home, '.ssh', 'id_rsa.pub')]

  for (const p of keyPaths) {
    try {
      return execSync(`cat "${p}"`, { encoding: 'utf-8' }).trim()
    } catch {
      // try next
    }
  }

  return null
}

async function keysRotate(): Promise<void> {
  console.log('')
  console.log('  🔑 Rotating SSH keys across all nodes')
  console.log('')

  const nodesFile = await loadNodesFile()
  if (!nodesFile) {
    console.error('  No .secrets/nodes.json found. Have you provisioned any nodes?')
    process.exit(1)
  }

  const pubkey = getPublicKey()
  if (!pubkey) {
    console.error('  No SSH public key found at ~/.ssh/id_ed25519.pub or ~/.ssh/id_rsa.pub')
    console.error('  Generate one with: ssh-keygen -t ed25519')
    process.exit(1)
  }

  const password = nodesFile.fallback_password
  if (!password) {
    console.error('  No fallback password found in .secrets/nodes.json')
    console.error('  Cannot rotate without a fallback authentication method.')
    process.exit(1)
  }

  const nodes = Object.entries(nodesFile.nodes)
  if (nodes.length === 0) {
    console.log('  No nodes registered. Nothing to rotate.')
    return
  }

  console.log(`  Public key: ${pubkey.substring(0, 50)}...`)
  console.log(`  Nodes: ${String(nodes.length)}`)
  console.log('')

  let success = 0
  let failed = 0

  for (const [id, node] of nodes) {
    process.stdout.write(`  ${node.hostname} (${node.ip})... `)

    // Try SSH first (current key might still work)
    const sshCmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o PasswordAuthentication=no root@${node.ip} "mkdir -p /root/.ssh && echo '${pubkey}' >> /root/.ssh/authorized_keys && sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"`

    try {
      execSync(sshCmd, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] })
      console.log('✅ (via SSH)')
      success++
      continue
    } catch {
      // SSH failed — try password
    }

    // Fall back to password auth via sshpass
    try {
      // Check if sshpass is available
      execSync('which sshpass', { stdio: ['pipe', 'pipe', 'pipe'] })

      const sshpassCmd = `sshpass -p '${password}' ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no root@${node.ip} "mkdir -p /root/.ssh && echo '${pubkey}' >> /root/.ssh/authorized_keys && sort -u /root/.ssh/authorized_keys -o /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"`

      execSync(sshpassCmd, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] })
      console.log('✅ (via password)')
      success++
    } catch {
      // sshpass not available or password failed
      console.log('❌ (SSH and password both failed)')
      console.log(`    Try: ssh root@${node.ip}  (manually add your key)`)
      console.log(`    Or:  pct enter ${id.replace('ct', '')}  (from Proxmox host)`)
      failed++
    }
  }

  console.log('')
  console.log(`  Done: ${String(success)} updated, ${String(failed)} failed`)

  if (failed > 0) {
    console.log('')
    console.log('  For failed nodes, you can:')
    console.log('    1. SSH with the fallback password and add your key manually')
    console.log('    2. Use Proxmox console (pct enter <ctid>) from the hypervisor')
  }

  console.log('')
}

async function keysList(): Promise<void> {
  console.log('')
  console.log('  🔑 Node Key Status')
  console.log('  ──────────────────')
  console.log('')

  const nodesFile = await loadNodesFile()
  if (!nodesFile) {
    console.log('  No .secrets/nodes.json found. Have you provisioned any nodes?')
    return
  }

  const nodes = Object.entries(nodesFile.nodes)
  if (nodes.length === 0) {
    console.log('  No nodes registered.')
    return
  }

  for (const [, node] of nodes) {
    // Try to SSH and check if we can connect
    let reachable = false
    try {
      execSync(
        `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o PasswordAuthentication=no root@${node.ip} "echo ok"`,
        { encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      reachable = true
    } catch {
      // Can't reach
    }

    const icon = reachable ? '🟢' : '🔴'
    console.log(`  ${icon} ${node.hostname} (${node.ip})`)
    console.log(`    Agent: ${node.agent} | Provider: ${node.provider}`)
    console.log(`    Node: ${node.pve_node} | Provisioned: ${node.provisioned_at}`)
    console.log(`    SSH:  ${reachable ? 'Key auth works' : 'Key auth failed — may need rotation'}`)
    console.log('')
  }
}
