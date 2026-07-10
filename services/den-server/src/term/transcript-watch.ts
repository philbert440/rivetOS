// Transcript watcher: the server side of push-based chat sync (seamless
// modes v2). For every session a RivetHub client has open, watch the
// harness's on-disk store file, reparse on change (debounced), and push
// versioned turn deltas over the sessions WS. The store file is the single
// source of truth — the chat view can no longer drift from the TUI, so the
// old pull-on-navigate heuristics and the manual resync button go away.
//
// Robustness posture:
// - fs.watch on the resolved store file, plus a slow safety poll (size/mtime)
//   that self-heals missed inotify events and rename-rotation (ENOENT →
//   re-resolve). Claude/grok stores append in place, so file-watch is the
//   fast path, not the only path.
// - A fresh conversation has no store file until its first turn lands — poll
//   for resolution until it appears (cheap existsSync-equivalent), then
//   switch to watching.
// - Parses never overlap per session; a change arriving mid-parse marks the
//   session dirty and reparses once the current pass finishes.
//
// Also emits a debounced {kind:'sessions-dirty'} whenever anything in a
// harness store directory changes, replacing the drawer's 30s poll.

import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { SessionWsFrame, TranscriptWsFrame } from '@rivetos/types'
import { harnessStoreDirs, readHarnessTranscript, resolveHarnessStore } from './harness-sessions.js'

/** Quiet window after a store change before reparsing — harnesses append in
 *  bursts (one line per content block). */
const DEBOUNCE_MS = 250
/** Fresh sessions: how often to look for a store file that doesn't exist yet. */
const RESOLVE_POLL_MS = 3_000
/** Safety poll for missed fs events on watched files. */
const SAFETY_POLL_MS = 10_000
/** Drawer refresh debounce — store dirs are chatty during turns. */
const SESSIONS_DIRTY_MS = 2_000

export interface TranscriptWatcher {
  /** Refcounted. The first watch resolves + parses the store and emits a
   *  full snapshot frame; later watches re-emit the cached snapshot. */
  watch(session: string): void
  unwatch(session: string): void
  /** Re-emit a full snapshot for an already-watched session (a client lost
   *  a delta and asked to realign). No refcount change. */
  sync(session: string): void
  close(): void
}

interface Watched {
  refs: number
  rev: number
  /** per-turn JSON signatures of the last emitted parse — diffing basis */
  sigs: string[]
  command: string
  file?: string
  fsWatcher?: FSWatcher
  debounce?: NodeJS.Timeout
  resolvePoll?: NodeJS.Timeout
  parsing: boolean
  dirty: boolean
  lastSize: number
  lastMtime: number
}

/** Timing overrides — tests dial these down; production uses the defaults. */
export interface TranscriptWatcherTimings {
  debounceMs?: number
  resolvePollMs?: number
  safetyPollMs?: number
  sessionsDirtyMs?: number
}

export function createTranscriptWatcher(
  emit: (frame: SessionWsFrame) => void,
  timings: TranscriptWatcherTimings = {},
): TranscriptWatcher {
  const debounceMs = timings.debounceMs ?? DEBOUNCE_MS
  const resolvePollMs = timings.resolvePollMs ?? RESOLVE_POLL_MS
  const safetyPollMs = timings.safetyPollMs ?? SAFETY_POLL_MS
  const sessionsDirtyMs = timings.sessionsDirtyMs ?? SESSIONS_DIRTY_MS
  const watched = new Map<string, Watched>()
  let closed = false

  // ---- sessions-dirty: store-dir watchers for the drawer -------------------
  let dirtyTimer: NodeJS.Timeout | undefined
  const dirWatchers: FSWatcher[] = []
  for (const dir of harnessStoreDirs()) {
    try {
      const w = watch(dir, { recursive: true }, () => {
        if (closed) return
        dirtyTimer ??= setTimeout(() => {
          dirtyTimer = undefined
          emit({ kind: 'sessions-dirty' })
        }, sessionsDirtyMs)
      })
      w.on('error', () => undefined) // dir removed later — safety poll owns files
      dirWatchers.push(w)
    } catch {
      // store dir absent on this node (no such harness installed) — skip
    }
  }

  const emitDelta = (
    session: string,
    s: Watched,
    turnsSigs: string[],
    turns: TranscriptWsFrame['turns'],
    command: string,
  ): void => {
    // First index where old and new disagree; unchanged prefix is not resent.
    let from = 0
    const max = Math.min(s.sigs.length, turnsSigs.length)
    while (from < max && s.sigs[from] === turnsSigs[from]) from++
    if (from === turnsSigs.length && turnsSigs.length === s.sigs.length && s.command === command) {
      return // nothing changed
    }
    s.sigs = turnsSigs
    s.command = command
    s.rev += 1
    emit({
      kind: 'transcript',
      session,
      rev: s.rev,
      from,
      turns: turns.slice(from),
      total: turns.length,
      command,
    })
  }

  // Cross-closure state changes (close(), a change event marking dirty during
  // the await) — read through the map so narrowing can't cache a stale value.
  const stillDirty = (session: string): boolean => {
    const s = watched.get(session)
    return !closed && !!s && s.dirty
  }

  const parseAndEmit = async (session: string): Promise<void> => {
    const s = watched.get(session)
    if (!s || closed) return
    if (s.parsing) {
      s.dirty = true
      return
    }
    s.parsing = true
    try {
      do {
        s.dirty = false
        const t = await readHarnessTranscript(session)
        const sigs = t.turns.map((turn) => JSON.stringify(turn))
        emitDelta(session, s, sigs, t.turns, t.command)
      } while (stillDirty(session))
    } catch {
      // unreadable mid-write — the next change/safety poll retries
    } finally {
      s.parsing = false
    }
  }

  const scheduleParse = (session: string): void => {
    const s = watched.get(session)
    if (!s || closed) return
    if (s.debounce) clearTimeout(s.debounce)
    s.debounce = setTimeout(() => {
      s.debounce = undefined
      void parseAndEmit(session)
    }, debounceMs)
  }

  const startFileWatch = (session: string, s: Watched, file: string): void => {
    s.file = file
    try {
      s.fsWatcher = watch(file, () => scheduleParse(session))
      s.fsWatcher.on('error', () => {
        // file rotated/removed — drop to re-resolution; safety poll rebuilds
        s.fsWatcher?.close()
        s.fsWatcher = undefined
        s.file = undefined
      })
    } catch {
      s.file = undefined // safety poll + resolve poll take over
    }
  }

  const tryResolve = async (session: string): Promise<void> => {
    const s = watched.get(session)
    if (!s || closed || s.file) return
    const ref = await resolveHarnessStore(session)
    if (!ref) return
    if (s.resolvePoll) {
      clearInterval(s.resolvePoll)
      s.resolvePoll = undefined
    }
    startFileWatch(session, s, ref.path)
    void parseAndEmit(session)
  }

  // One safety poll for all watched sessions: catch missed events, vanished
  // files (re-resolve), and hermes WAL writes that inotify can miss.
  const safety = setInterval(() => {
    if (closed) return
    for (const [session, s] of watched) {
      if (!s.file) {
        continue // resolve poll owns unresolved sessions
      }
      void stat(s.file).then(
        (st) => {
          if (st.size !== s.lastSize || st.mtimeMs !== s.lastMtime) {
            s.lastSize = st.size
            s.lastMtime = st.mtimeMs
            scheduleParse(session)
          }
        },
        () => {
          // store file vanished — rotate back to resolution
          s.fsWatcher?.close()
          s.fsWatcher = undefined
          s.file = undefined
          s.resolvePoll ??= setInterval(() => void tryResolve(session), resolvePollMs)
        },
      )
    }
  }, safetyPollMs)
  safety.unref()

  // Full-snapshot re-emit: late subscribers and delta-gap recovery. Reparses
  // from disk (not the sig cache — sigs don't hold the turns) and realigns
  // every subscriber's rev.
  const emitSnapshot = (session: string): void => {
    void readHarnessTranscript(session).then((t) => {
      const s = watched.get(session)
      if (!s || closed) return
      s.sigs = t.turns.map((turn) => JSON.stringify(turn))
      s.command = t.command
      s.rev += 1
      emit({
        kind: 'transcript',
        session,
        rev: s.rev,
        from: 0,
        turns: t.turns,
        total: t.turns.length,
        command: t.command,
      })
    })
  }

  return {
    watch(session: string): void {
      if (closed || !session || session.includes('/') || session.includes('..')) return
      const existing = watched.get(session)
      if (existing) {
        existing.refs += 1
        // Late subscriber: emit a full snapshot so it seeds immediately.
        emitSnapshot(session)
        return
      }
      const s: Watched = {
        refs: 1,
        rev: 0,
        sigs: [],
        command: '',
        parsing: false,
        dirty: false,
        lastSize: -1,
        lastMtime: -1,
      }
      watched.set(session, s)
      void resolveHarnessStore(session).then((ref) => {
        const cur = watched.get(session)
        if (!cur || closed) return
        if (ref) {
          startFileWatch(session, cur, ref.path)
        } else {
          // no store yet (fresh draft) — emit an explicit empty snapshot so
          // the client knows the store state, then poll for the file
          cur.rev += 1
          emit({
            kind: 'transcript',
            session,
            rev: cur.rev,
            from: 0,
            turns: [],
            total: 0,
            command: '',
          })
          cur.resolvePoll = setInterval(() => void tryResolve(session), resolvePollMs)
          return
        }
        void parseAndEmit(session)
      })
    },

    unwatch(session: string): void {
      const s = watched.get(session)
      if (!s) return
      s.refs -= 1
      if (s.refs > 0) return
      if (s.debounce) clearTimeout(s.debounce)
      if (s.resolvePoll) clearInterval(s.resolvePoll)
      s.fsWatcher?.close()
      watched.delete(session)
    },

    sync(session: string): void {
      if (closed || !watched.has(session)) return
      emitSnapshot(session)
    },

    close(): void {
      closed = true
      clearInterval(safety)
      if (dirtyTimer) clearTimeout(dirtyTimer)
      for (const w of dirWatchers) w.close()
      for (const [, s] of watched) {
        if (s.debounce) clearTimeout(s.debounce)
        if (s.resolvePoll) clearInterval(s.resolvePoll)
        s.fsWatcher?.close()
      }
      watched.clear()
    },
  }
}
