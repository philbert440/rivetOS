/**
 * rivetos service <action>
 *
 * Generate and manage the systemd service.
 *   rivetos service init       Generate systemd unit file
 *   rivetos service start      Start the service
 *   rivetos service stop       Stop the service
 *   rivetos service restart    Restart the service
 *   rivetos service status     Show service status
 *   rivetos service logs       Tail service logs
 */

import { writeFile, access } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const SERVICE_NAME = 'rivetos'

function getServicePath(): string {
  const uid = process.getuid?.()
  if (uid === 0) {
    return `/etc/systemd/system/${SERVICE_NAME}.service`
  }
  return resolve(process.env.HOME ?? '.', '.config', 'systemd', 'user', `${SERVICE_NAME}.service`)
}

function isRoot(): boolean {
  return process.getuid?.() === 0
}

function systemctl(cmd: string): string {
  const userFlag = isRoot() ? '' : '--user'
  try {
    return execSync(`systemctl ${userFlag} ${cmd}`, { encoding: 'utf-8', timeout: 10000 })
  } catch (err: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return err.stdout ?? (err as Error).message
  }
}

export default async function service(): Promise<void> {
  const action = process.argv[3]

  if (!action || action === 'help') {
    console.log(`Usage: rivetos service <action>

  init      Generate systemd unit file
  start     Start the service
  stop      Stop the service
  restart   Restart the service
  status    Show service status
  logs      Tail service logs
`)
    return
  }

  switch (action) {
    case 'init': {
      const servicePath = getServicePath()
      const workingDir = process.cwd()
      const envFile = resolve(process.env.HOME ?? '.', '.rivetos', '.env')
      const configFile = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
      const tsxPath = resolve(workingDir, 'node_modules', '.bin', 'tsx')
      const bootPath = resolve(workingDir, 'src', 'boot.ts')

      // Check if npx tsx or direct tsx
      let execStart = `npx tsx ${bootPath} ${configFile}`
      try {
        await access(tsxPath)
        execStart = `${tsxPath} ${bootPath} ${configFile}`
      } catch {
        /* expected */
      }

      const unit = `[Unit]
Description=RivetOS Agent Runtime
After=network.target

[Service]
Type=simple
WorkingDirectory=${workingDir}
ExecStart=${execStart}
EnvironmentFile=${envFile}
Environment=RIVETOS_LOG_LEVEL=info
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=${isRoot() ? 'multi-user.target' : 'default.target'}
`

      try {
        await access(servicePath)
        console.log(`Service file already exists: ${servicePath}`)
        console.log('Delete it first if you want to regenerate.')
        return
      } catch {
        /* expected */
      }

      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      mkdirSync(dirname(servicePath), { recursive: true })
      await writeFile(servicePath, unit)

      console.log(`✅ Service file created: ${servicePath}`)
      console.log('')
      console.log('Enable and start:')
      const userFlag = isRoot() ? '' : '--user '
      console.log(`  systemctl ${userFlag}daemon-reload`)
      console.log(`  systemctl ${userFlag}enable ${SERVICE_NAME}`)
      console.log(`  systemctl ${userFlag}start ${SERVICE_NAME}`)
      console.log('')
      console.log('Or use: rivetos service start')
      break
    }

    case 'start':
      systemctl(`daemon-reload`)
      console.log(systemctl(`start ${SERVICE_NAME}`))
      console.log(systemctl(`status ${SERVICE_NAME}`))
      break

    case 'stop':
      console.log(systemctl(`stop ${SERVICE_NAME}`))
      break

    case 'restart':
      systemctl(`daemon-reload`)
      console.log(systemctl(`restart ${SERVICE_NAME}`))
      console.log(systemctl(`status ${SERVICE_NAME}`))
      break

    case 'status':
      console.log(systemctl(`status ${SERVICE_NAME}`))
      break

    case 'logs': {
      const userFlag = isRoot() ? '' : '--user '
      try {
        execSync(`journalctl ${userFlag}-u ${SERVICE_NAME} -f --no-pager`, { stdio: 'inherit' })
      } catch {
        /* expected */
      }
      break
    }

    default:
      console.error(`Unknown action: ${action}`)
      process.exit(1)
  }
}
