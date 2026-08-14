/**
 * Spawn-or-get mutex for the one harness PTY behind a conversation.
 *
 * The terminal spawn effect, chat sends, and StrictMode double-mounts can all
 * ask for the PTY concurrently — they must share ONE spawn request, not race
 * two past the "already have one" check (grok review, PR #349). This module
 * is that check + the single-flight, framework-free so the React layer only
 * supplies the sinks (`current` / `spawn`), like harness-attach.ts.
 *
 * The ensurer never holds the PTY id itself: ownership stays with the caller
 * (a ref the unmount cleanup can kill), and `current()` is consulted on every
 * call so an externally killed/evicted PTY is respawned on the next ensure.
 */

export interface PtyEnsurerOptions {
  /** The currently attached PTY id, or undefined when none is live. */
  current: () => string | undefined
  /**
   * Spawn (or resume) the conversation's harness PTY and resolve its id.
   * Must publish the id to the caller's own slot before resolving — a
   * `current()` re-check inside `spawn` is the defense against a spawn that
   * completed between the outer check and this call.
   */
  spawn: () => Promise<string>
}

/** Single-flight ensure: concurrent callers share one in-flight spawn. */
export function createPtyEnsurer(opts: PtyEnsurerOptions): () => Promise<string> {
  let inflight: Promise<string> | null = null
  return () => {
    const cur = opts.current()
    if (cur) return Promise.resolve(cur)
    inflight ??= opts.spawn().finally(() => {
      inflight = null
    })
    return inflight
  }
}
