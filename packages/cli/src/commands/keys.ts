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

  // Parse --ssh-user flag
  let sshUser = 'rivet'
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--ssh-user' && args[i + 1]) {
      sshUser = args[++i]
    }
  }

  switch (subcommand) {
    case 'rotate':
      await keysRotate(sshUser)
      break
    case 'list':
    case 'status':
      await keysList(sshUser)
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

async function keysRotate(sshUser = 'rivet'): Promise<void> {
  console.log('')
  console.log(`  🔑 Rotating SSH keys across all nodes (ssh-user: ${sshUser})`)
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

    // Build the authorized_keys update command for a given user/home
    const makeAddKeyCmd = (targetHome: string) =>
      `mkdir -p ${targetHome}/.ssh && echo '${pubkey}' >> ${targetHome}/.ssh/authorized_keys && sort -u ${targetHome}/.ssh/authorized_keys -o ${targetHome}/.ssh/authorized_keys && chmod 600 ${targetHome}/.ssh/authorized_keys && chown -R $(stat -c '%U' ${targetHome}) ${targetHome}/.ssh`

    // Try primary user first (rivet by default), then root fallback
    const usersToTry: Array<{ user: string; home: string; label: string }> = []
    if (sshUser !== 'root') {
      usersToTry.push({ user: sshUser, home: `/home/${sshUser}`, label: sshUser })
    }
    usersToTry.push({ user: 'root', home: '/root', label: 'root (fallback)' })

    let nodeSuccess = false

    for (const { user, home, label } of usersToTry) {
      // Try SSH key auth first
      const sshCmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o PasswordAuthentication=no ${user}@${node.ip} "${makeAddKeyCmd(home)}"`
      try {
        execSync(sshCmd, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] })
        console.log(`✅ (${label} via SSH key)`)
        nodeSuccess = true
        // Also update the other user's authorized_keys (dual-key window)
        if (user !== 'root') {
          try {
            execSync(
              `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o PasswordAuthentication=no ${user}@${node.ip} "${makeAddKeyCmd('/root')}"`,
              { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
            )
          } catch {
            // non-fatal — root might not exist yet or have sudo access
          }
        }
        break
      } catch {
        // Try password fallback
      }

      // Fall back to password auth via sshpass
      try {
        execSync('which sshpass', { stdio: ['pipe', 'pipe', 'pipe'] })
        const sshpassCmd = `sshpass -p '${password}' ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${user}@${node.ip} "${makeAddKeyCmd(home)}"`
        execSync(sshpassCmd, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] })
        console.log(`✅ (${label} via password)`)
        nodeSuccess = true
        break
      } catch {
        // try next user
      }
    }

    if (!nodeSuccess) {
      console.log('❌ (all auth methods failed)')
      console.log(`    Try: ssh rivet@${node.ip}  or  ssh root@${node.ip}  (add key manually)`)
      console.log(`    Or:  pct enter ${id.replace('ct', '')}  (from Proxmox host)`)
      failed++
    } else {
      success++
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

async function keysList(sshUser = 'rivet'): Promise<void> {
  console.log('')
  console.log(`  🔑 Node Key Status (ssh-user: ${sshUser})`)
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
    // Try rivet@ first, then root@ — report which works
    let reachableAs: string | null = null
    for (const user of sshUser !== 'root' ? [sshUser, 'root'] : ['root']) {
      try {
        execSync(
          `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o PasswordAuthentication=no ${user}@${node.ip} "echo ok"`,
          { encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] },
        )
        reachableAs = user
        break
      } catch {
        // try next
      }
    }

    const icon = reachableAs ? '🟢' : '🔴'
    const sshStatus = reachableAs
      ? `Key auth works as ${reachableAs}@${node.ip}`
      : 'Key auth failed — may need rotation'
    console.log(`  ${icon} ${node.hostname} (${node.ip})`)
    console.log(`    Agent: ${node.agent} | Provider: ${node.provider}`)
    console.log(`    Node: ${node.pve_node} | Provisioned: ${node.provisioned_at}`)
    console.log(`    SSH:  ${sshStatus}`)
    if (reachableAs === 'root' && sshUser !== 'root') {
      console.log(`    ⚠️  Reachable only as root — run migrate-to-rivet-user.sh on this node`)
    }
    console.log('')
  }
}
