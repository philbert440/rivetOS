// PTY backend seam. The manager and the HTTP layer only ever see PtySpawn /
// PtyProc — tests inject a scripted fake, production lazily loads node-pty.
//
// node-pty is an optionalDependency (native addon; needs a C++ toolchain at
// install time). Its absence must degrade to "term endpoints answer 503", not
// take the whole den down — the event relay works fine without terminals.

export interface PtyProc {
  pid: number
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(cb: (data: string | Buffer) => void): void
  onExit(cb: (exitCode: number | null) => void): void
}

export interface PtySpawnOpts {
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export type PtySpawn = (argv: string[], opts: PtySpawnOpts) => PtyProc

// Just the node-pty surface we touch — typed locally so the build never
// depends on the optional package being installed.
interface NodePtyLike {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): {
    pid: number
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
    onData(cb: (data: string) => void): unknown
    onExit(cb: (ev: { exitCode: number; signal?: number }) => void): unknown
  }
}

let loaded: Promise<PtySpawn | null> | null = null

/** Memoized node-pty loader: one import attempt, one log line on failure,
 *  null forever after — callers translate null into 503. */
export function loadRealPtySpawn(
  log: (msg: string) => void = console.error,
): Promise<PtySpawn | null> {
  loaded ??= (async (): Promise<PtySpawn | null> => {
    try {
      // non-literal specifier: tsc must not try to resolve types for a
      // package that may legitimately be absent (optional native dep)
      const specifier: string = 'node-pty'
      const pty = (await import(specifier)) as NodePtyLike
      return (argv, opts) => {
        const proc = pty.spawn(argv[0], argv.slice(1), {
          name: 'xterm-256color',
          cols: opts.cols,
          rows: opts.rows,
          cwd: opts.cwd,
          env: opts.env,
        })
        return {
          pid: proc.pid,
          write: (data) => proc.write(typeof data === 'string' ? data : data.toString('utf8')),
          resize: (cols, rows) => proc.resize(cols, rows),
          kill: (signal) => proc.kill(signal),
          onData: (cb) => void proc.onData(cb),
          onExit: (cb) => void proc.onExit(({ exitCode }) => cb(exitCode)),
        }
      }
    } catch (e) {
      log(`[den-server] term: node-pty unavailable — terminals disabled (${String(e)})`)
      return null
    }
  })()
  return loaded
}

/** Test hook: forget the memoized import result. */
export function resetRealPtySpawnForTests(): void {
  loaded = null
}
