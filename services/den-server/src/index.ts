import { loadConfig } from './config.js'
import { startCoworkCaptureCatchUp } from './harness/cowork-capture-boot.js'
import { createDenServer } from './server.js'

const config = loadConfig()
const den = createDenServer(config)

den.server.listen(config.port, config.host, () => {
  console.log(
    `[den-server] listening on ${config.host}:${config.port} (POST /event, WS /ws)` +
      (config.token ? ' [auth on]' : ' [auth off]'),
  )
  startCoworkCaptureCatchUp()
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void den.close().then(() => process.exit(0))
  })
}
