import { createRequire } from 'node:module'

const packageJson = process.argv[2]
const connectionString = process.env.RIVETOS_PG_URL
if (!packageJson) {
  console.error('graphile-worker package.json path is required')
  process.exit(1)
}
if (!connectionString) {
  console.error('RIVETOS_PG_URL is required')
  process.exit(1)
}
const require = createRequire(packageJson)
const worker = require('graphile-worker')
if (typeof worker.runMigrations !== 'function') {
  console.error('graphile-worker did not export runMigrations')
  process.exit(1)
}
await worker.runMigrations({
  connectionString,
  concurrency: 1,
  maxPoolSize: 2,
  noHandleSignals: true,
})
