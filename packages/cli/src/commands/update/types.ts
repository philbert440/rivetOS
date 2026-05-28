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
  /** Also attempt nodes the roster marks offline (recovery deploys). Default false. */
  includeOffline: boolean
}

export interface NodeUpdateResult {
  success: boolean
  commit?: string
  failedStep?: string
  elapsedMs: number
  workers?: string[]
}
