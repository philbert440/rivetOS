/**
 * systemd plumbing for the migration: scope-aware systemctl commands and the
 * rivethub.service unit.
 *
 * The unit is rendered here rather than by `rh service init` for two
 * reasons. `rh service init` points EnvironmentFile at ~/.rivethub/.env,
 * which does not exist until RivetHub has moved the state directory during
 * that very first start, so the first start would run without the node's
 * credentials; ~/.rivetos/.env is valid before the move and, through the
 * symlink, after it. And a system unit written by `rh service init` under
 * sudo would take root's HOME and carry no User=, while the old unit ran as
 * the install owner. The settings match the production cutover runbook.
 */

export type UnitScope = 'system' | 'user' | 'none'

export const TS_UNIT = 'rivetos.service'
export const HUB_UNIT = 'rivethub.service'

export interface ScopeContext {
  uid: number
  /** XDG_RUNTIME_DIR from the environment, if set. */
  runtimeDir?: string
}

/** Prefix for commands that need root: nothing as root, `sudo -n` otherwise. */
export function asRoot(cmd: string, ctx: ScopeContext): string {
  return ctx.uid === 0 ? cmd : `sudo -n ${cmd}`
}

/**
 * `systemctl` for a scope. User scope sets XDG_RUNTIME_DIR, which an SSH
 * session from `--mesh` does not always have.
 */
export function systemctl(scope: 'system' | 'user', args: string, ctx: ScopeContext): string {
  if (scope === 'system') return asRoot(`systemctl ${args}`, ctx)
  const runtime = ctx.runtimeDir ?? `/run/user/${String(ctx.uid)}`
  return `XDG_RUNTIME_DIR=${runtime} systemctl --user ${args}`
}

export function unitPath(scope: 'system' | 'user', home: string): string {
  return scope === 'system'
    ? `/etc/systemd/system/${HUB_UNIT}`
    : `${home}/.config/systemd/user/${HUB_UNIT}`
}

export interface UnitInput {
  scope: 'system' | 'user'
  user: string
  home: string
  rhPath: string
}

export function renderHubUnit(input: UnitInput): string {
  const { scope, user, home, rhPath } = input
  const lines = [
    '[Unit]',
    'Description=RivetHub',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
  ]
  if (scope === 'system') lines.push(`User=${user}`)
  lines.push(
    `WorkingDirectory=${home}`,
    `Environment=HOME=${home}`,
    `Environment=PATH=${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    'Environment=TERM=xterm-256color',
    'Environment=RIVETHUB_LOG_LEVEL=info',
    `EnvironmentFile=-${home}/.rivetos/.env`,
    `ExecStart=${rhPath} start`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    `WantedBy=${scope === 'system' ? 'multi-user.target' : 'default.target'}`,
    '',
  )
  return lines.join('\n')
}
