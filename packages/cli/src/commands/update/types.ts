/** Shared types for the `rivetos update` command and its remote-node workers. */

export interface UpdateOptions {
  version?: string
  restart: boolean
  prebuilt: boolean
  mesh: boolean
  bareMetal: boolean
  sshUser: string
  /** Use npm install -g @rivetos/cli@<channel> instead of git pull */
  npm: boolean
  /** npm dist-tag or version specifier — defaults to "beta" */
  channel: string
  /** Obsolete: every node is probed over SSH now regardless of roster
   *  status (a reachable host with a crashed service is exactly what an
   *  update fixes). Kept so existing invocations don't break. */
  includeOffline: boolean
}

export interface NodeUpdateResult {
  success: boolean
  commit?: string
  failedStep?: string
  elapsedMs: number
  workers?: string[]
  /** Post-update `config validate` failed — the service will crash-loop
   *  until ~/.rivetos/config.yaml is fixed (update itself succeeded). */
  configInvalid?: boolean
}
