import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

it('installed wrapper selects pg when no launcher helper exists', () => {
  execFileSync('bash', [fileURLToPath(new URL('./wrapper.test.sh', import.meta.url))], {
    stdio: 'inherit',
  })
})
