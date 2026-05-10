/**
 * Phase: Postgres connection.
 *
 * For docker/proxmox deployments the wizard ships a bundled datahub container
 * and the connection string is generated automatically. For manual deployments
 * the user supplies their own postgres — prompt for the URL.
 */

import * as p from '@clack/prompts'

function bail<T>(v: T | symbol): asserts v is T {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
}

const EXAMPLE_URL = 'postgres://user:password@host:5432/dbname'

export async function configurePostgres(): Promise<string> {
  p.log.step('Postgres Connection')
  const url = await p.text({
    message: 'Postgres connection string',
    placeholder: EXAMPLE_URL,
    validate: (raw) => {
      const value = (raw ?? '').trim()
      if (!value) return 'Required.'
      if (!/^postgres(ql)?:\/\/.+/.test(value)) {
        return `Expected ${EXAMPLE_URL}`
      }
      return undefined
    },
  })
  bail(url)
  return url.trim()
}
